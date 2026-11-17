"""Exercise build-copy safety with real debug ELF libraries on Linux."""
import ctypes
import importlib.util
from pathlib import Path
import shutil
import struct
import subprocess
import sys

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "slim_frozen_runtime.py"
SPEC = importlib.util.spec_from_file_location("slim_frozen_runtime", SCRIPT)
slimming = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(slimming)


@pytest.fixture
def debug_library(tmp_path):
    if sys.platform != "linux" or not shutil.which("cc") or not shutil.which("strip"):
        pytest.skip("Real ELF build safety needs Linux cc and GNU strip")
    source = tmp_path / "sample.c"
    source.write_text("int answer(void) { return 42; }\n")
    library = tmp_path / "libsample.so"
    subprocess.run(["cc", "-shared", "-fPIC", "-g", str(source), "-o", str(library)], check=True)
    return library


def test_rejects_non_elf_without_touching_source(tmp_path):
    original = tmp_path / "runtime"
    original.write_bytes(b"not-an-elf-runtime")
    with pytest.raises(ValueError, match="ELF64"):
        slimming.strip_debug_copy(original, tmp_path / "cache")
    assert original.read_bytes() == b"not-an-elf-runtime"
    assert not (tmp_path / "cache").exists()


def test_real_debug_strip_preserves_loaded_function_and_original(debug_library, tmp_path):
    original = debug_library.read_bytes()
    candidate, report = slimming.strip_debug_copy(debug_library, tmp_path / "cache")
    assert candidate != debug_library
    assert debug_library.read_bytes() == original
    assert report["afterBytes"] < report["beforeBytes"]
    assert report["debugBytes"] > 0
    assert ctypes.CDLL(str(candidate)).answer() == 42
    assert slimming.elf_layout(candidate.read_bytes())["debugBytes"] == 0


def test_changed_executable_bytes_fail_closed(debug_library, tmp_path, monkeypatch):
    original = debug_library.read_bytes()
    real_run = slimming.subprocess.run

    def corrupt_after_strip(command, **kwargs):
        result = real_run(command, **kwargs)
        target = Path(command[-1])
        data = bytearray(target.read_bytes())
        header = struct.unpack_from("<16sHHIQQQIHHHHHH", data)
        for index in range(header[12]):
            section = struct.unpack_from("<IIQQQQIIQQ", data, header[6] + index * header[11])
            if section[2] & 4 and section[5]:  # SHF_EXECINSTR
                data[section[4]] ^= 1
                break
        target.write_bytes(data)
        return result

    monkeypatch.setattr(slimming.subprocess, "run", corrupt_after_strip)
    with pytest.raises(ValueError, match="load segments"):
        slimming.strip_debug_copy(debug_library, tmp_path / "cache")
    assert debug_library.read_bytes() == original
    assert list((tmp_path / "cache").iterdir()) == []


def test_cache_symlink_is_rejected(debug_library, tmp_path):
    cache = tmp_path / "cache"
    cache.symlink_to(tmp_path, target_is_directory=True)
    original = debug_library.read_bytes()
    with pytest.raises(ValueError, match="symlink"):
        slimming.strip_debug_copy(debug_library, cache)
    assert debug_library.read_bytes() == original
