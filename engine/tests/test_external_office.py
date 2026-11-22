import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from docx import Document

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import material_workshop_engine as engine


class ExternalOfficeTests(unittest.TestCase):
    def test_conversion_stages_away_from_deep_output_and_reopens_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "材料.doc"
            source.write_bytes(b"read-only fixture")
            target = root / ("nested" * 15) / ("results" * 10) / "converted.docx"
            seen = []

            def convert(command, directory):
                staged_source = Path(command[-1])
                self.assertEqual(staged_source.read_bytes(), source.read_bytes())
                self.assertFalse(directory.is_relative_to(target.parent))
                seen.append(directory)
                out = Path(command[command.index("--outdir") + 1])
                result = Document()
                result.add_paragraph("校验新成果")
                result.save(out / (staged_source.stem + ".docx"))
                return 0, ""

            with patch.object(engine, "libreoffice_path", return_value=Path("soffice")), \
                 patch.object(engine, "run_libreoffice", side_effect=convert):
                result = engine.convert_office_with_libreoffice(source, target, "doc-to-docx")
            self.assertIn("docx_reopened", result["verification"])
            self.assertEqual(Document(target).paragraphs[0].text, "校验新成果")
            self.assertEqual(source.read_bytes(), b"read-only fixture")
            self.assertFalse(seen[0].exists())

    @unittest.skipUnless(sys.platform == "win32", "uses Windows DLL loader APIs")
    def test_system_child_does_not_inherit_frozen_dll_paths(self):
        import ctypes

        kernel = ctypes.windll.kernel32

        def dll_directory():
            value = ctypes.create_unicode_buffer(32768)
            kernel.GetDllDirectoryW(len(value), value)
            return value.value or None

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "_MEItest"
            bundle.mkdir()
            private_bin = bundle / "bin"
            private_bin.mkdir()
            other = root / "_MEItest-other"
            other.mkdir()
            before = dll_directory()
            self.assertTrue(kernel.SetDllDirectoryW(str(bundle)))
            try:
                path = os.pathsep.join([str(private_bin), str(other), os.environ["PATH"]])
                with patch.object(sys, "_MEIPASS", str(bundle), create=True), patch.dict(os.environ, PATH=path):
                    command = [
                        sys.executable, "-c",
                        "import ctypes,os,json,sys; s=ctypes.create_unicode_buffer(32768); "
                        "ctypes.windll.kernel32.GetDllDirectoryW(len(s),s); "
                        "paths=os.get_exec_path(); "
                        "print(json.dumps([s.value,sys.argv[1] in paths,sys.argv[2] in paths]))",
                        str(private_bin), str(other),
                    ]
                    code, output = engine.run_libreoffice(command, root)
                    self.assertEqual(code, 0, output)
                    child_dll, private_in_path, other_in_path = json.loads(output)
                    self.assertFalse(child_dll)
                    self.assertFalse(private_in_path)
                    self.assertTrue(other_in_path)
                    self.assertEqual(dll_directory(), str(bundle))
            finally:
                kernel.SetDllDirectoryW(before)


if __name__ == "__main__":
    unittest.main()
