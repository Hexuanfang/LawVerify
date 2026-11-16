"""读取 Word 97–2003 复合文档的正文分片。"""
import re
from struct import iter_unpack, unpack_from

SIGNATURE = bytes.fromhex("D0 CF 11 E0 A1 B1 1A E1")
END, FREE = 0xFFFFFFFE, 0xFFFFFFFF


def u16(data, offset):
    return unpack_from("<H", data, offset)[0]


def u32(data, offset):
    return unpack_from("<I", data, offset)[0]


class CompoundDocument:
    def __init__(self, data):
        if len(data) < 512 or not data.startswith(SIGNATURE):
            raise ValueError("不是有效的 OLE2 复合文档")
        # 部分 WPS 文件在签名和标准头部之间加入了前缀。
        header = next((i for i in range(8, 65, 2)
                       if u16(data, i + 4) == 0xFFFE and u16(data, i + 6) in (9, 12)
                       and u16(data, i + 8) == 6), None)
        if header is None:
            raise ValueError("OLE2 文档头部格式无效")
        self.data = data
        self.size = 1 << u16(data, header + 6)
        self.sectors = len(data) // self.size - 1
        self.cutoff = u32(data, header + 32)
        fat_count = u32(data, header + 20)
        difat_count = u32(data, header + 48)
        if max(fat_count, difat_count) > self.sectors:
            raise ValueError("OLE2 扇区数量无效")
        fat_sectors = [index for (index,) in iter_unpack("<I", data[header + 52:header + 52 + 109 * 4])
                       if index not in (END, FREE)][:fat_count]
        next_sector = u32(data, header + 44)
        visited = set()
        for _ in range(difat_count):
            if len(fat_sectors) == fat_count:
                break
            if next_sector in (END, FREE) or next_sector in visited:
                raise ValueError("OLE2 扩展分配表无效")
            visited.add(next_sector)
            sector = self.sector(next_sector)
            remaining = fat_count - len(fat_sectors)
            fat_sectors.extend([index for (index,) in iter_unpack("<I", sector[:-4])
                                if index not in (END, FREE)][:remaining])
            next_sector = u32(sector, self.size - 4)
        if len(fat_sectors) != fat_count or len(set(fat_sectors)) != fat_count:
            raise ValueError("OLE2 分配表不完整")
        self.fat = [entry[0] for index in fat_sectors
                    for entry in iter_unpack("<I", self.sector(index))]
        self.entries = {}
        self.root = None
        directory = self.chain(u32(data, header + 24), self.fat, self.sector)
        for i in range(0, len(directory) - 127, 128):
            length = u16(directory, i + 64)
            kind = directory[i + 66]
            entry = (u32(directory, i + 116), u32(directory, i + 120))
            if kind == 5:
                self.root = entry
            if kind == 2 and 2 <= length <= 64 and length % 2 == 0:
                name = directory[i:i + length - 2].decode("utf-16-le", errors="replace")
                self.entries[name] = entry
        count = u32(data, header + 40)
        mini_fat = self.chain(u32(data, header + 36), self.fat, self.sector, count * self.size) if count else b""
        self.mini_fat = [entry[0] for entry in iter_unpack("<I", mini_fat)]

    def sector(self, index):
        if not 0 <= index < self.sectors:
            raise ValueError("OLE2 扇区位置无效")
        start = (index + 1) * self.size
        return self.data[start:start + self.size]

    @staticmethod
    def chain(index, allocation, read, size=None):
        if size == 0:
            return b""
        chunks, visited, length = [], set(), 0
        while index not in (END, FREE):
            if index in visited or index >= len(allocation):
                raise ValueError("OLE2 分配链无效")
            visited.add(index)
            chunk = read(index)
            if not chunk:
                raise ValueError("OLE2 数据流不完整")
            chunks.append(chunk)
            length += len(chunk)
            if size is not None and length >= size:
                break
            index = allocation[index]
        if size is not None and length < size:
            raise ValueError("OLE2 数据流不完整")
        return b"".join(chunks)[:size]

    def stream(self, name):
        if name not in self.entries:
            raise ValueError(f"文档缺少 {name} 流")
        start, size = self.entries[name]
        if size >= self.cutoff:
            return self.chain(start, self.fat, self.sector, size)
        root = self.chain(self.root[0], self.fat, self.sector, self.root[1]) if self.root else b""
        return self.chain(start, self.mini_fat, lambda index: root[index * 64:(index + 1) * 64], size)


def extract_legacy_word(data):
    document = CompoundDocument(data)
    word = document.stream("WordDocument")
    if len(word) < 64 or u16(word, 0) != 0xA5EC:
        raise ValueError("不是 Word 97–2003 文档")
    flags = u16(word, 10)
    if flags & 0x0100:
        raise ValueError("文档已加密，无法抽取正文")
    long_words = 34 + u16(word, 32) * 2
    main_length = u32(word, long_words + 14)
    pairs = long_words + 2 + u16(word, long_words) * 4
    if u16(word, pairs) <= 33:
        raise ValueError("文档缺少正文分片表")
    start, size = unpack_from("<II", word, pairs + 2 + 33 * 8)
    table = document.stream("1Table" if flags & 0x0200 else "0Table")
    clx = table[start:start + size]
    offset = 0
    while offset < len(clx) and clx[offset] == 1:
        offset += 3 + u16(clx, offset + 1)
    if offset >= len(clx) or clx[offset] != 2:
        raise ValueError("文档缺少正文分片表")
    length = u32(clx, offset + 1)
    pieces = clx[offset + 5:offset + 5 + length]
    if len(pieces) != length or length < 16 or (length - 4) % 12:
        raise ValueError("文档正文分片表无效")
    count = (length - 4) // 12
    parts = []
    for i in range(count):
        first, last = unpack_from("<II", pieces, 4 * i)
        if main_length:
            last = min(last, main_length)
        if last <= first:
            continue
        position = u32(pieces, (count + 1) * 4 + i * 8 + 2)
        compressed = bool(position & 0x40000000)
        start = position & 0x3FFFFFFF
        start = start // 2 if compressed else start
        end = start + (last - first) * (1 if compressed else 2)
        if end > len(word):
            raise ValueError("文档正文分片超出数据流")
        parts.append(word[start:end].decode("cp1252" if compressed else "utf-16-le", errors="replace"))
    raw = "".join(parts)
    text = re.sub(r"\x13[^\x14\x15]*(?:\x14|\x15)|[\x14\x15]", "", raw)
    text = re.sub(r"\x01[^\x08]*\x08|\x01", "", text)
    text = text.translate(str.maketrans({"\r": "\n", "\v": "\n", "\f": "\n", "\x07": "\t", "\x1e": "-"}))
    text = re.sub(r"[\x00-\x08\x0b-\x1f]", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()
