"""MinerU 本地解析适配，模型在进程内复用。"""
import importlib.metadata
from hashlib import sha256
import io
import html
import json
import os
import re
from pathlib import Path
import tempfile
from time import perf_counter
import unicodedata

from PIL import Image, ImageOps

from chat import analyze_chat, ocr_lines
from legacy_word import extract_legacy_word
from word_blocks import parse_word
from worker_limits import is_memory_limit_error


def text_content(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(text_content(item) for item in value)
    if isinstance(value, dict):
        return text_content(value.get("content", []))
    return ""


def normalized_text(value):
    return "".join(unicodedata.normalize("NFKC", value).split())


def normalized_lines(value):
    # 以完整文字行为边界，较长金额、负数及中文数字不能覆盖另一行的金额。
    return {normalized_text(line) for line in value.splitlines() if line.strip()}


class Parser:
    def __init__(self, memory_bounded=False):
        # Windows 的原生 DLL 初始化须先于阻塞式输入线程。
        from mineru.parser import parse
        from mineru.model.registry import MINERU_4_MODELS_ONNX
        from mineru.model.ocr.pp_ocr_v6_onnx import PPOCRv6ONNX
        from mineru.model.runtime.device_state import resolve_runtime_device
        runtime = resolve_runtime_device(allow_download=False)
        if runtime.backend == "torch":
            from mineru.model.runtime.hybrid import AtomModelSingleton
            from mineru.model.runtime.contracts import AtomicModelName
            self.ocr = AtomModelSingleton().get_atom_model(atom_model_name=AtomicModelName.OCR, lang="ch", enable_merge_det_boxes=False)
            self.providers = [f"torch:{runtime.model_device}"]
        else:
            self.ocr = PPOCRv6ONNX(str(MINERU_4_MODELS_ONNX.ocr_det.ensure(source="local")),
                                  str(MINERU_4_MODELS_ONNX.ocr_rec.ensure(source="local")),
                                  enable_merge_det_boxes=False, drop_score=0.1)
            self.providers = self.ocr.text_recognizer.session.get_providers()
        self.device = runtime.device
        self.version = importlib.metadata.version("mineru")
        self.parse_document = parse
        self.memory_bounded = memory_bounded
        self.pdf_scope = None
        self.pdf_images = {}

    def recognize_image(self, image):
        if image.width * image.height > 100_000_000:
            raise ValueError("图片像素过大")
        image = ImageOps.exif_transpose(image).convert("RGB")
        lines, _ = ocr_lines(self.ocr, image, [], image.height > 1500)
        return "\n".join(line["text"] for line in lines)

    def recognize_pdf_image(self, bitmap):
        key = (bitmap.width, bitmap.height, bitmap.stride, bitmap.format, sha256(bitmap.buffer).digest())
        if key not in self.pdf_images:
            text = self.recognize_image(bitmap.to_pil())
            # 只缓存同一任务中像素完全一致的图片，来源页码仍由当前页生成。
            if len(self.pdf_images) < 128 and len(text) <= 8000:
                self.pdf_images[key] = text
            return text
        return self.pdf_images[key]

    def parse_word(self, path, result):
        def recognize(data):
            with Image.open(io.BytesIO(data)) as source:
                return self.recognize_image(source)

        blocks, warnings = parse_word(path, recognize)
        result["blocks"] = [dict(block, page=0, bbox=[], coordinateSpace="document") for block in blocks]
        result["warnings"].extend(warnings)
        result["text"] = "\n\n".join(f"【来源：{block['locator']}】\n{block['text']}" for block in blocks)
        result["html"] = word_html(blocks)

    def parse_legacy_word(self, path, result):
        if path.stat().st_size > 64 * 1024 ** 2:
            raise ValueError("旧版 Word 文件超过安全处理上限")
        result["text"] = extract_legacy_word(path.read_bytes())

    def parse(self, input_path, mode="auto", file_name=None, mime_type="", *, pdf_scope=None, page_offset=0):
        path = Path(input_path)
        if pdf_scope is None or pdf_scope != self.pdf_scope:
            self.pdf_images.clear()
        self.pdf_scope = pdf_scope
        suffix = Path(file_name or path.name).suffix.lower()
        result = {"schemaVersion": 1, "engineVersion": self.version, "text": "", "pages": 0,
                  "blocks": [], "warnings": [], "reviewRequired": False}
        if suffix == ".docx":
            self.parse_word(path, result)
        elif suffix == ".doc":
            self.parse_legacy_word(path, result)
        elif suffix in {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".rtf"} or mime_type.startswith("text/") or mime_type == "application/rtf":
            with path.open("rb") as stream:
                data = stream.read(32 * 1024 ** 2 + 1)
            if len(data) > 32 * 1024 ** 2:
                raise ValueError("文本文件超过安全处理上限")
            content = data.decode("utf-8-sig", errors="replace").strip()
            result["text"] = rtf_text(content) if suffix == ".rtf" or "rtf" in mime_type else content
        elif suffix == ".gif":
            with Image.open(path) as source:
                result["text"] = self.recognize_image(source)
            result["pages"] = 1
            result["warnings"].append("GIF 仅识别首帧")
        else:
            return self.parse_visual_document(path, mode, result, file_name, page_offset)
        if len(result["text"]) + len(result.get("html", "")) > 8_000_000:
            raise ValueError("解析正文超过安全处理上限，请拆分材料")
        if not result["text"].strip():
            result["warnings"].append("原件未提取到可读文字，请人工审核")
            result["reviewRequired"] = True
        return result


    def parse_visual_document(self, path, mode, result, file_name=None, page_offset=0):
        if path.suffix.lower() == ".pdf":
            import pypdfium2
            document = pypdfium2.PdfDocument(path)
            try:
                if len(document) > 1000:
                    raise ValueError("材料超过1000页，请拆分后解析")
            finally:
                document.close()
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif"}:
            with Image.open(path) as source:
                if source.width * source.height > 100_000_000:
                    raise ValueError("图片像素过大，请拆分后解析")
                image = ImageOps.exif_transpose(source).convert("RGB")
                chat = analyze_chat(image, file_name or path.name, self.ocr, mode) if mode != "document" else None
            if chat is not None:
                result["chat"] = chat
                result["pages"] = 1
                texts = [f"聊天标题 {chat['title']}，身份未经核实。"]
                for message in chat["messages"]:
                    sender = "本人侧" if message["side"] == "right" else message["display_name"] or "对方侧"
                    timestamp = message["time_context"] or "时间未显示"
                    texts.append(f"[{timestamp}，时间分隔上下文] {sender}\n{message['text']}")
                    result["blocks"].append({"page": 1, "bbox": message["bbox"], "coordinateSpace": "pixel",
                                             "text": texts[-1]})
                    result["warnings"].extend(message["warnings"])
                result["text"] = "\n\n".join(texts)
                result["warnings"].extend(chat["warnings"])
                result["reviewRequired"] = chat["status"] == "manual_review"
                return result
        # basic 不调用远程或本地 VLM，负责正文、版面与表格结构。
        started = perf_counter()
        parsed = self.parse_document(path, tier="basic", ocr_mode="auto", image_analysis=False)
        if len(parsed.pages) > 1000:
            raise ValueError("材料超过1000页，请拆分后解析")
        # 图片二进制引用不属于正文，避免空扫描件被误判为已有文字并送入模型。
        result["text"] = re.sub(r"!\[[^\]]*\]\(data:[^)]*\)", "", parsed.markdown()).strip()
        result["pages"] = len(parsed.pages)
        for page in parsed.to_dict().get("pages", []):
            for block in page.get("blocks", []):
                result["blocks"].append({"page": page["page_idx"] + 1, "bbox": block.get("bbox", []),
                                         "coordinateSpace": "normalized", "text": text_content(block.get("content", []))})
        if path.suffix.lower() == ".pdf":
            from loguru import logger

            supplement_started = perf_counter()
            self.supplement_pdf_images(path, result, page_offset)
            logger.info("LawVerify PDF phases: main_s={:.3f}, supplement_s={:.3f}",
                        supplement_started - started, perf_counter() - supplement_started)
        if not result["text"].strip():
            result["warnings"].append("原件未提取到可读文字，请人工审核")
            result["reviewRequired"] = True
        if len(result["text"]) > 8_000_000:
            raise ValueError("解析正文超过安全处理上限，请拆分材料")
        return result

    def supplement_pdf_images(self, path, result, page_offset=0):
        import pypdfium2
        import pypdfium2.raw as pdfium

        supplements = []
        visible_markdown = re.sub(r"(?m)^#{1,6}[ \t]+", "", result["text"])
        parsed_lines = normalized_lines(re.sub(r"\\([^\w\s]|_)", r"\1", visible_markdown))
        document = pypdfium2.PdfDocument(path)
        try:
            for index in range(len(document)):
                page = document[index]
                try:
                    text_page = page.get_textpage()
                    try:
                        native_text = text_page.get_text_range()
                    finally:
                        text_page.close()
                    native = normalized_lines(native_text)
                    if not native:
                        continue
                    # 按页比较，标点宽度差异不应导致原生文字被重复追加。
                    covered = normalized_lines("\n".join(block["text"] for block in result["blocks"]
                                                        if block["page"] == index + 1))
                    missing = "\n".join(line.strip() for line in native_text.splitlines()
                                        if line.strip() and (normalized_text(line) not in covered
                                                             or normalized_text(line) not in parsed_lines))
                    if missing:
                        locator = f"第 {page_offset + index + 1} 页 · 原生文本"
                        supplements.append(f"【来源：{locator}】\n{missing}")
                        missing_blocks = "\n".join(line for line in missing.splitlines()
                                                    if normalized_text(line) not in covered)
                        if missing_blocks:
                            result["blocks"].append(dict(page=index + 1, bbox=list(page.get_bbox()),
                                                         coordinateSpace="pdf", text=missing_blocks, locator=locator, kind="native_text"))
                    for number, image in enumerate(page.get_objects(filter=[pdfium.FPDF_PAGEOBJ_IMAGE]), 1):
                        locator = f"第 {page_offset + index + 1} 页 · 第 {number} 张图"
                        try:
                            width, height = image.get_px_size()
                            if min(width, height) < 20:
                                continue
                            if width * height > 100_000_000:
                                raise ValueError("图片像素过大")
                            bitmap = image.get_bitmap()
                            try:
                                text = self.recognize_pdf_image(bitmap)
                            finally:
                                bitmap.close()
                            text = "\n".join(line for line in text.splitlines()
                                             if normalized_text(line) and normalized_text(line) not in native
                                             and (normalized_text(line) not in covered
                                                  or normalized_text(line) not in parsed_lines))
                            if text:
                                supplements.append(f"【来源：{locator}】\n{text}")
                                result["blocks"].append(dict(page=index + 1, bbox=list(image.get_bounds()),
                                                             coordinateSpace="pdf", text=text, locator=locator, kind="image"))
                        except Exception as error:
                            if self.memory_bounded and is_memory_limit_error(error):
                                raise
                            result["warnings"].append(f"{locator}识别失败，请核对原件")
                finally:
                    page.close()
        finally:
            document.close()
        if supplements:
            result["text"] = "\n\n".join([result["text"], *supplements])


def rtf_text(content):
    content = re.sub(r"\\par(?:d)?\b ?", "\n", content)
    content = re.sub(r"\\'[0-9a-fA-F]{2}", " ", content)
    content = re.sub(r"\\[a-z]+-?\d* ?|[{}]", " ", content)
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[^\S\n]+\n", "\n", content)).strip()


def word_html(blocks):
    result = []
    rows = {}
    table = None

    def flush():
        if rows:
            result.append("<table>" + "".join("<tr>" + "".join(
                f'<td colspan="{span}">{"<br>".join(values)}</td>'
                for span, values in cells.values()) + "</tr>" for cells in rows.values()) + "</table>")
            rows.clear()

    for block in blocks:
        if block.get("table") != table:
            flush()
            table = block.get("table")
        text = html.escape(block["text"]).replace("\n", "<br>")
        if table is None:
            result.append(f"<p>{text}</p>")
        else:
            row = rows.setdefault(block["row"], {})
            row.setdefault(block["column"], (block.get("columnSpan", 1), []))[1].append(text)
    flush()
    return "".join(result)

def save_result(result, output_path):
    path = Path(output_path)
    root = Path(os.environ["LAWVERIFY_PARSER_ROOT"]).resolve()
    path = path.resolve()
    if not path.is_relative_to(root):
        raise ValueError("解析结果目录超出工作区")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".parse-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
