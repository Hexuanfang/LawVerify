"""生成可核对的合成聊天截图，预期消息只供测试断言使用。"""
from pathlib import Path
import json
import os
from struct import pack_into
from zipfile import ZipFile

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(os.environ["PARSER_FIXTURE_DIR"])
FONT = os.environ.get("OCR_TEST_FONT", "C:/Windows/Fonts/simhei.ttf")
WIDTH = 900
BACKGROUND = (237, 237, 237)


def message(side, text, name=None, time=None):
    return {"side": side, "text": text, "name": name, "time": time}


def screenshot(filename, title, messages, group=False):
    font = ImageFont.truetype(FONT, 30)
    small = ImageFont.truetype(FONT, 24)
    title_font = ImageFont.truetype(FONT, 34)
    y = 110
    boxes, names, times = [], [], []
    for item in messages:
        if item.get("time"):
            times.append((y, item["time"]))
            y += 58
        if group and item["side"] == "left":
            names.append((130, y, item["name"]))
            y += 36
        lines = item["text"].split("\n")
        text_width = max(font.getlength(line) for line in lines)
        bubble_width = max(90, int(text_width) + 42)
        height = len(lines) * 44 + 24
        x = 130 if item["side"] == "left" else WIDTH - 130 - bubble_width
        boxes.append((x, y, x + bubble_width, y + height, item))
        y += height + 42
    image = Image.new("RGB", (WIDTH, max(1050, y + 100)), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, WIDTH, 90), fill=(247, 247, 247))
    draw.text((35, 25), "<", font=title_font, fill=(40, 40, 40))
    draw.text((WIDTH / 2, 26), title, font=title_font, fill=(20, 20, 20), anchor="mt")
    for time_y, text in times:
        draw.text((WIDTH / 2, time_y), text, font=small, fill=(125, 125, 125), anchor="mt")
    for x, name_y, name in names:
        draw.text((x, name_y), name, font=small, fill=(100, 100, 100))
    for x1, y1, x2, y2, item in boxes:
        color = (255, 255, 255) if item["side"] == "left" else (149, 236, 105)
        draw.rounded_rectangle((x1, y1, x2, y2), radius=10, fill=color)
        avatar_x = 35 if item["side"] == "left" else WIDTH - 95
        avatar_color = {"张三": (72, 129, 168), "李四": (170, 112, 65), "王五": (120, 80, 160)}.get(item["name"], (75, 135, 160))
        draw.rounded_rectangle((avatar_x, y1, avatar_x + 60, y1 + 60), radius=5, fill=avatar_color)
        for index, line in enumerate(item["text"].split("\n")):
            draw.text((x1 + 21, y1 + 12 + 44 * index), line, font=font, fill=(20, 20, 20))
    path = ROOT / "samples" / filename
    image.save(path)
    return {"file": filename, "title": title, "group": group, "messages": messages,
            "size": list(image.size)}


def generate():
    (ROOT / "samples").mkdir(parents=True, exist_ok=True)
    cases = []
    cases.append(screenshot("single.png", "李四", [
        message("left", "借款123456.78元，尚未归还。", time="2026年11月16日 09:30"),
        message("right", "我核对后回复。"),
        message("left", "请保留转账凭证。"),
        message("left", "还款期限是本周五。"),
        message("right", "目前未结清。\n剩余金额需核对。", time="09:35"),
        message("left", "好的。"),
        message("right", "好的。"),
    ]))
    cases.append(screenshot("group.png", "借款核对群（4）", [
        message("left", "请核对借款金额。", "张三", "2026年11月16日 10:00"),
        message("left", "我已整理转账记录。", "李四"),
        message("right", "请分别说明。"),
        message("left", "尚欠123456.78元。", "张三"),
        message("left", "这笔款尚未收到。", "王五"),
        message("left", "我下午再核实。", "李四", "10:05"),
    ], group=True))
    long_messages = []
    for index in range(24):
        side = "left" if index % 3 != 1 else "right"
        time = f"11:{index:02d}" if index % 4 == 0 else None
        long_messages.append(message(side, f"第{index + 1:02d}项记录金额{1000 + index}.00元。\n此项尚未完成核对。", time=time))
    cases.append(screenshot("long.png", "李四", long_messages))
    continuous = [
        message("left", "第一笔借款已经确认。", time="2026年11月16日 14:00"),
        message("right", "我查一下第二笔。"),
        message("left", "第二笔金额是8000.00元。"),
        message("right", "尚未归还。"),
        message("left", "收到。"),
        message("right", "收到。"),
        message("left", "明天提供凭证。", time="14:10"),
        message("right", "请发送完整记录。"),
    ]
    cases.append(screenshot("continuous-1.png", "李四", continuous[:6]))
    cases.append(screenshot("continuous-2.png", "李四", continuous[2:]))
    # 重复短句与无重叠对话用于检查错误合并风险。
    cases.append(screenshot("no-overlap.png", "李四", [
        message("left", "新的话题。", time="15:00"),
        message("right", "收到。"),
    ]))
    write = {"cases": cases, "continuous_expected": continuous,
             "scope": "合成浅色主题中文文字聊天，真实身份未经核实"}
    (ROOT / "expected.json").write_text(json.dumps(write, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"generated": len(cases), "sizes": {c["file"]: c["size"] for c in cases}}, ensure_ascii=False))



def document_samples():
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    pdfmetrics.registerFont(TTFont("Chinese", FONT))
    def text_page(pdf):
        pdf.setFont("Chinese", 18)
        pdf.drawString(40, 780, "借款金额123456.78元，尚未归还。")
        pdf.showPage()
    samples = ROOT / "samples"
    for name, scanned in [("text.pdf", False), ("scan.pdf", True), ("mixed.pdf", True), ("table.pdf", False)]:
        pdf = canvas.Canvas(str(samples / name))
        text_page(pdf)
        if scanned:
            for _ in range(2):
                pdf.drawImage(str(samples / "group.png"), 0, 0, width=595, height=770)
                pdf.showPage()
        pdf.save()
    pdf = canvas.Canvas(str(samples / "same-page.pdf"))
    pdf.drawString(40, 780, "Native text on image page")
    pdf.drawImage(str(samples / "group.png"), 40, 40, width=500, height=650)
    pdf.save()
    pdf = canvas.Canvas(str(samples / "graphics-only.pdf"))
    pdf.rect(30, 30, 100, 100, fill=1)
    pdf.save()

    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    drawing = '<w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r>'
    table = '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    mixed = f'<w:p><w:r><w:t>图片前</w:t></w:r>{drawing}<w:r><w:t>图片后</w:t></w:r></w:p>{table}'
    for name, body in [("screenshots.docx", f"<w:p>{drawing}</w:p>"), ("mixed.docx", mixed)]:
        with ZipFile(samples / name, "w") as archive:
            archive.writestr("word/document.xml", f'<w:document xmlns:w="{w}" xmlns:r="{r}" xmlns:a="{a}"><w:body>{body}</w:body></w:document>')
            archive.writestr("word/_rels/document.xml.rels", f'<Relationships><Relationship Id="rId1" Type="{r}/image" Target="media/group.png"/></Relationships>')
            archive.write(samples / "group.png", "word/media/group.png")
    (samples / "plain.txt").write_text("普通文本证据", encoding="utf-8-sig")
    (samples / "rich-text.rtf").write_text(r"{\rtf1 First paragraph\par Second paragraph}", encoding="ascii")


def legacy_word_sample(path, text, prefix=0):
    end, free = 0xFFFFFFFE, 0xFFFFFFFF
    header, directory = bytearray(512), bytearray(512)
    word, table = bytearray(4096), bytearray(4096)
    raw = text.encode("utf-16-le")
    count = len(raw) // 2
    header[:8] = bytes.fromhex("D0 CF 11 E0 A1 B1 1A E1")
    base = 8 + prefix
    pack_into("<HHHHH", header, base, 0x003E, 3, 0xFFFE, 9, 6)
    pack_into("<II", header, base + 20, 1, 1)
    pack_into("<I", header, base + 32, 4096)
    pack_into("<I", header, base + 44, end)
    fat = bytearray(512)
    values = [0xFFFFFFFD, end, *range(3, 10), end, *range(11, 18), end]
    pack_into("<128I", fat, 0, *(values + [free] * (128 - len(values))))
    for i, (name, kind, start, size) in enumerate([
            ("Root Entry", 5, end, 0), ("WordDocument", 2, 2, len(word)), ("0Table", 2, 10, len(table))]):
        offset = i * 128
        name_data = name.encode("utf-16-le")
        directory[offset:offset + len(name_data)] = name_data
        pack_into("<HB", directory, offset + 64, len(name_data) + 2, kind)
        pack_into("<II", directory, offset + 116, start, size)
    pack_into("<H", word, 0, 0xA5EC)
    pack_into("<H", word, 32, 14)
    pack_into("<H", word, 62, 22)
    pack_into("<I", word, 76, count)
    pack_into("<H", word, 152, 93)
    pack_into("<II", word, 154 + 33 * 8, 0, 21)
    word[1024:1024 + len(raw)] = raw
    pack_into("<BIIIHIH", table, 0, 2, 16, 0, count, 0, 1024, 0)
    path.write_bytes(header + fat + directory + word + table)

if __name__ == "__main__":
    generate()
    document_samples()
    legacy_word_sample(ROOT / "samples" / "legacy.doc", "律师函\r见附件\x13 HYPERLINK \x14附件一\x15。")
    legacy_word_sample(ROOT / "samples" / "wps-prefix.doc", "附件一：证据目录。", 16)
