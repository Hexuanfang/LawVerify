"""验证 PDF 补充抽取的正文覆盖判断，无需启动模型。"""
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
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


if __name__ == "__main__":
    unittest.main()
