"""读取 DOCX 正文、原生表格及嵌图的文档顺序。"""
from pathlib import PurePosixPath
import posixpath
from xml.etree import ElementTree as ET
from zipfile import ZipFile

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
V = "{urn:schemas-microsoft-com:vml}"


def read_part(archive, name, limit):
    if archive.getinfo(name).file_size > limit:
        raise ValueError("Word 部件超过解析上限")
    return archive.read(name)


def parse_word(path, recognize=None):
    blocks, warnings = [], []
    paragraph = table = image = 0

    def add(kind, locator, text, **position):
        if text.strip():
            blocks.append(dict(kind=kind, locator=locator, text=text, **position))

    with ZipFile(path) as archive:
        limit = 16 * 1024 ** 2
        document = ET.fromstring(read_part(archive, "word/document.xml", limit))
        try:
            relations = ET.fromstring(read_part(archive, "word/_rels/document.xml.rels", limit))
        except KeyError:
            relations = []
        media = {}
        for relation in relations:
            target = relation.get("Target", "")
            if relation.get("Type", "").endswith("/image") and relation.get("TargetMode") != "External":
                part = posixpath.normpath(target.lstrip("/") if target.startswith("/") else f"word/{target}")
                if part.startswith("word/") and ".." not in PurePosixPath(part).parts:
                    media[relation.get("Id")] = part

        def read_paragraph(node, locator, **position):
            nonlocal image
            pending = []
            kind = "table_cell" if "row" in position else "paragraph"
            for element in node.iter():
                if element.tag == W + "t":
                    pending.append(element.text or "")
                elif element.tag in (W + "tab", W + "br", W + "cr"):
                    pending.append("\t" if element.tag == W + "tab" else "\n")
                elif element.tag in (A + "blip", V + "imagedata"):
                    if recognize is None:
                        continue
                    add(kind, locator, "".join(pending), **position)
                    pending.clear()
                    image += 1
                    anchor = f"{locator} · 第 {image} 张图"
                    try:
                        part = media[element.get(R + "embed") or element.get(R + "id")]
                        content = recognize(read_part(archive, part, limit))
                        if not content.strip():
                            raise ValueError("无可识别文字")
                        add("image", anchor, content, image=image, **position)
                    except Exception:
                        warnings.append(f"{anchor}未提取到可核对文字")
            add(kind, locator, "".join(pending), **position)

        def walk(node):
            nonlocal table, paragraph
            for child in node:
                if child.tag == W + "p":
                    paragraph += 1
                    read_paragraph(child, f"第 {paragraph} 段", paragraph=paragraph)
                elif child.tag == W + "tbl":
                    table += 1
                    table_number = table
                    for row, tr in enumerate(child.findall(W + "tr"), 1):
                        offset = tr.find(f"{W}trPr/{W}gridBefore")
                        column = 1 + (int(offset.get(W + "val", "0")) if offset is not None else 0)
                        for cell in tr.findall(W + "tc"):
                            grid = cell.find(f"{W}tcPr/{W}gridSpan")
                            span = max(1, int(grid.get(W + "val", "1"))) if grid is not None else 1
                            vertical = cell.find(f"{W}tcPr/{W}vMerge")
                            merge = vertical.get(W + "val", "continue") if vertical is not None else None
                            locator = f"第 {table_number} 张表第 {row} 行第 {column} 列"
                            for item in cell:
                                if item.tag == W + "p":
                                    read_paragraph(item, locator, table=table_number, row=row, column=column,
                                                   columnSpan=span, verticalMerge=merge)
                                elif item.tag == W + "tbl":
                                    walk([item])
                            column += span
                elif child.tag in (W + "sdt", W + "sdtContent", W + "customXml"):
                    walk(child)

        body = document.find(W + "body")
        if body is None:
            raise ValueError("Word 文件缺少正文")
        walk(body)
    return blocks, warnings
