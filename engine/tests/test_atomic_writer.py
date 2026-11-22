from pathlib import Path
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from material_workshop_engine import atomic_writer, copy_atomic


class AtomicWriterTests(unittest.TestCase):
    def test_writes_new_output_and_preserves_a_read_only_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            generated = root / "generated.txt"
            atomic_writer(generated, lambda path: path.write_bytes(b"generated"))
            self.assertEqual(generated.read_bytes(), b"generated")
            source = root / "original.txt"
            copied = root / "copy.txt"
            source.write_bytes(b"original")
            source.chmod(stat.S_IREAD)
            try:
                copy_atomic(source, copied)
                self.assertEqual(copied.read_bytes(), source.read_bytes())
                self.assertFalse(source.stat().st_mode & stat.S_IWRITE)
                self.assertFalse(copied.stat().st_mode & stat.S_IWRITE)
                self.assertEqual(list(root.glob(".*.part")), [])
            finally:
                source.chmod(stat.S_IREAD | stat.S_IWRITE)
                if copied.is_file():
                    copied.chmod(stat.S_IREAD | stat.S_IWRITE)
