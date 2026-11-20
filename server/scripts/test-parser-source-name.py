"""验证原件显示名称不会被临时文件名替换。"""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

project = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(project / "python-workers"))
from parsing import Parser


class SourceNameTests(unittest.TestCase):
    def test_chat_keeps_original_file_name(self):
        with tempfile.TemporaryDirectory(dir=project / "tmp") as directory:
            source = Path(directory) / "source.png"
            Image.new("RGB", (20, 20), "white").save(source)
            parser = Parser.__new__(Parser)
            parser.version = "test"
            parser.ocr = None
            chat = {"title": "聊天", "messages": [], "warnings": [], "status": "ready"}
            with patch("parsing.analyze_chat", return_value=chat) as analyze:
                parser.parse(source, file_name="原始聊天.png")
            self.assertEqual(analyze.call_args.args[1], "原始聊天.png")


if __name__ == "__main__":
    unittest.main()
