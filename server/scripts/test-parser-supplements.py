"""验证 PDF 补充抽取的正文覆盖判断，无需启动模型。"""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python-workers"))
from parsing import Parser


class SupplementTests(unittest.TestCase):
    def supplement(self, native, text, block):
        page = MagicMock()
        page.get_textpage.return_value.get_text_range.return_value = native
        page.get_objects.return_value = []
        document = MagicMock()
        document.__len__.return_value = 1
        document.__getitem__.return_value = page
        result = {"text": text, "blocks": [{"page": 1, "text": block}], "warnings": []}
        with patch("pypdfium2.PdfDocument", return_value=document):
            Parser.__new__(Parser).supplement_pdf_images(Path("fixture.pdf"), result)
        return result

    def test_missing_number_is_not_a_substring_duplicate(self):
        for existing, missing in [("1000", "100"), ("100.50", "100"),
                                  ("-100", "100"), ("十一万元", "一万元")]:
            with self.subTest(existing=existing):
                result = self.supplement(f"{existing}\n{missing}", existing, existing)
                self.assertTrue(result["text"].endswith(f"\n{missing}"))
                self.assertEqual(result["blocks"][-1]["text"], missing)

    def test_existing_numeric_lines_remain_distinct(self):
        result = self.supplement("1000\n100", "1000\n100", "1000\n100")
        self.assertEqual(result["text"], "1000\n100")
        self.assertEqual(len(result["blocks"]), 1)

    def test_markdown_escapes_do_not_duplicate_visible_text(self):
        for native, markdown in [("Account ABC_DEF", r"Account ABC\_DEF"),
                                 ("Amount $100", r"Amount \$100")]:
            with self.subTest(native=native):
                result = self.supplement(native, markdown, native)
                self.assertEqual(result["text"], markdown)
                self.assertEqual(len(result["blocks"]), 1)

    def test_supplement_cache_requires_identical_pixels_and_bitmap_shape(self):
        parser = Parser.__new__(Parser)
        parser.pdf_images = {}
        parser.recognize_image = MagicMock(side_effect=["同一金额", "不同像素", "不同步长"])

        def bitmap(pixels, stride=3):
            return SimpleNamespace(width=1, height=1, stride=stride, format=2, buffer=pixels, to_pil=MagicMock())

        self.assertEqual(parser.recognize_pdf_image(bitmap(b"abc")), "同一金额")
        self.assertEqual(parser.recognize_pdf_image(bitmap(b"abc")), "同一金额")
        self.assertEqual(parser.recognize_pdf_image(bitmap(b"abd")), "不同像素")
        self.assertEqual(parser.recognize_pdf_image(bitmap(b"abc", stride=4)), "不同步长")
        self.assertEqual(parser.recognize_image.call_count, 3)

    def test_supplement_reports_ocr_memory_error_and_offsets_generated_locators(self):
        parser = Parser.__new__(Parser)
        parser.memory_bounded = True
        parser.recognize_pdf_image = MagicMock(side_effect=RuntimeError("Failed to allocate memory"))
        image = MagicMock()
        image.get_px_size.return_value = (80, 100)
        page = MagicMock()
        page.get_textpage.return_value.get_text_range.return_value = "原生行"
        page.get_objects.return_value = [image]
        document = MagicMock()
        document.__len__.return_value = 1
        document.__getitem__.return_value = page
        result = {"text": "【来源：第 5 页的合同】", "blocks": [], "warnings": []}
        with patch("pypdfium2.PdfDocument", return_value=document):
            with self.assertRaisesRegex(RuntimeError, "Failed to allocate memory"):
                parser.supplement_pdf_images(Path("fixture.pdf"), result, page_offset=20)
            parser.recognize_pdf_image.side_effect = ValueError("invalid bitmap")
            parser.supplement_pdf_images(Path("fixture.pdf"), result, page_offset=20)
        self.assertEqual(result["warnings"], ["第 21 页 · 第 1 张图识别失败，请核对原件"])
        self.assertEqual(result["blocks"][0]["page"], 1)
        self.assertEqual(result["blocks"][0]["locator"], "第 21 页 · 原生文本")
        self.assertTrue(result["text"].startswith("【来源：第 5 页的合同】"))


if __name__ == "__main__":
    unittest.main()
