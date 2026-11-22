#!/usr/bin/env python3
"""Report unresolved native imports in an installed Windows build or test binary."""
import ctypes
import os
from pathlib import Path
import sys

import pefile


def main():
    program = Path(sys.argv[1]).resolve(strict=True)
    loader = ctypes.WinDLL("kernel32", use_last_error=True)
    lookup = loader.GetProcAddress
    lookup.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    lookup.restype = ctypes.c_void_p
    problems = []
    with os.add_dll_directory(str(program.parent)), pefile.PE(str(program), fast_load=True) as pe:
        pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"]])
        for library in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []):
            name = library.dll.decode("ascii")
            local = program.parent / name
            try:
                module = ctypes.WinDLL(str(local) if local.is_file() else name)
            except OSError as error:
                problems.append(f"{name}: loader error {error.winerror}")
                continue
            for symbol in library.imports:
                pointer = (ctypes.cast(ctypes.c_char_p(symbol.name), ctypes.c_void_p)
                           if symbol.name else ctypes.c_void_p(symbol.ordinal))
                if not lookup(module._handle, pointer):
                    label = symbol.name.decode("ascii") if symbol.name else f"ordinal {symbol.ordinal}"
                    problems.append(f"{name}!{label}")
    print(f"Windows import check {program.name}: {len(problems)} unresolved direct imports", flush=True)
    for problem in problems:
        print("Unresolved:", problem)


if __name__ == "__main__":
    main()
