#!/usr/bin/env python3
"""Build-only removal of libpython DWARF data, never an installed runtime.

PyInstaller's global strip=True invokes plain strip on every binary. Instead,
replace only its libpython TOC source with a checked, private build copy.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def elf_layout(data: bytes) -> dict:
    """Read ELF64 LE tables without adding a packaging dependency."""
    if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01":
        raise ValueError("Expected a little-endian ELF64 runtime")
    header = struct.unpack_from("<16sHHIQQQIHHHHHH", data)
    _, kind, machine, _, _, phoff, shoff, _, _, phsize, phnum, shsize, shnum, shstr = header
    if kind != 3 or phsize != 56 or shsize != 64 or not 0 < shstr < shnum:
        raise ValueError("Unsupported shared-library ELF layout")
    if phoff + phnum * phsize > len(data) or shoff + shnum * shsize > len(data):
        raise ValueError("Truncated ELF tables")
    sections = [struct.unpack_from("<IIQQQQIIQQ", data, shoff + i * shsize) for i in range(shnum)]
    strings = sections[shstr]
    names = data[strings[4]:strings[4] + strings[5]]
    allocated = []
    debug_bytes = 0
    for section in sections:
        name_offset, section_type, flags, address, offset, size, _, _, align, entry = section
        if name_offset >= len(names):
            raise ValueError("Invalid ELF section name")
        name = names[name_offset:].split(b"\0", 1)[0].decode("ascii")
        if section_type != 8 and offset + size > len(data):  # SHT_NOBITS has no payload
            raise ValueError("Truncated ELF section")
        if name.startswith((".debug", ".zdebug")):
            if flags & 2:
                raise ValueError("Refusing to remove an allocated debug section")
            debug_bytes += size
        if flags & 2:  # SHF_ALLOC: code, constants, dynamic symbols, relocations, etc.
            payload = b"" if section_type == 8 else data[offset:offset + size]
            allocated.append((name, section_type, flags, address, size, align, entry, sha256(payload)))
    programs = data[phoff:phoff + phnum * phsize]
    loads = []
    for i in range(phnum):
        kind, _, offset, _, _, size, _, _ = struct.unpack_from("<IIQQQQQQ", programs, i * phsize)
        if kind != 1:  # PT_LOAD
            continue
        if offset + size > len(data):
            raise ValueError("Truncated ELF load segment")
        payload = bytearray(data[offset:offset + size])
        # Only the section-header location/count/name-table-index in the ELF
        # header may change. These are debugger/linker metadata, not load data.
        for start, end in ((40, 48), (60, 64)):
            if offset <= start and end <= offset + size:
                payload[start - offset:end - offset] = b"\0" * (end - start)
        loads.append(sha256(payload))
    return {
        "machine": machine,
        "debugBytes": debug_bytes,
        "runtime": {"programHeaders": sha256(programs), "loadSegments": loads, "allocatedSections": allocated},
    }


def strip_debug_copy(source: Path, cache: Path, strip_program: str = "strip") -> tuple[Path, dict]:
    source = source.resolve(strict=True)
    original = source.read_bytes()
    before = elf_layout(original)
    record = {"source": str(source), "sourceSha256": sha256(original), "beforeBytes": len(original),
              "debugBytes": before["debugBytes"], "runtimeSha256": sha256(json.dumps(before["runtime"], sort_keys=True).encode())}
    if before["debugBytes"] == 0:
        return source, {**record, "afterBytes": len(original), "outputSha256": record["sourceSha256"], "changed": False}
    cache.mkdir(parents=True, exist_ok=True)
    if cache.is_symlink():
        raise ValueError("Build cache must not be a symlink")
    destination = cache / (record["sourceSha256"] + "-" + source.name)
    if destination.is_symlink() or destination.resolve() == source:
        raise ValueError("Refusing to overwrite a runtime or follow a cache symlink")
    descriptor, name = tempfile.mkstemp(prefix=".strip-debug-", dir=cache)
    os.close(descriptor)
    temporary = Path(name)
    try:
        shutil.copyfile(source, temporary)
        subprocess.run([strip_program, "--strip-debug", str(temporary)], check=True, capture_output=True, timeout=60)
        optimized = temporary.read_bytes()
        after = elf_layout(optimized)
        if before["machine"] != after["machine"] or before["runtime"] != after["runtime"]:
            raise ValueError("strip-debug changed load segments or allocated sections")
        if after["debugBytes"] or len(optimized) >= len(original):
            raise ValueError("strip-debug did not remove the expected debugging data")
        if source.read_bytes() != original:
            raise ValueError("Original runtime changed during packaging")
        temporary.chmod(source.stat().st_mode & 0o777)
        os.replace(temporary, destination)
        return destination, {**record, "output": str(destination), "afterBytes": len(optimized),
                             "outputSha256": sha256(optimized), "changed": True}
    finally:
        temporary.unlink(missing_ok=True)


def prepare_analysis(analysis, workpath: str) -> None:
    """Called after Analysis and before EXE; all data and other binaries survive."""
    if os.environ.get("MATERIAL_WORKSHOP_SLIM_LINUX") != "1":
        return
    if sys.platform != "linux":
        raise RuntimeError("Linux runtime slimming requested on a different platform")
    work = Path(workpath)
    records = []
    binaries = []
    for destination, source, kind in analysis.binaries:
        if kind == "BINARY" and re.fullmatch(r"libpython3\.\d+\.so(?:\.\d+)*", destination):
            optimized, record = strip_debug_copy(Path(source), work / "stripped-runtime")
            records.append({"destination": destination, **record})
            binaries.append((destination, str(optimized), kind))
        else:
            binaries.append((destination, source, kind))
    if len(records) != 1:
        raise RuntimeError(f"Expected exactly one libpython runtime, found {len(records)}")
    analysis.binaries = binaries
    (work / "runtime-slimming.json").write_text(json.dumps({"strategy": "libpython-only-strip-debug", "files": records}, indent=2) + "\n")
