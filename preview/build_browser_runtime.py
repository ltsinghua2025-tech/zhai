#!/usr/bin/env python3
"""Assemble the pinned, same-origin ZHAI browser runtime for GitHub Pages."""

import ast
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import tarfile
from tempfile import TemporaryDirectory
from textwrap import dedent
from urllib.request import urlopen
from zipfile import ZipFile


PREVIEW = Path(__file__).resolve().parent
ENGINE = PREVIEW.parent / "engine"
VERSION = "314.0.8"
CDN = f"https://cdn.jsdelivr.net/pyodide/v{VERSION}/full/"
CORE = (
    f"https://github.com/pyodide/pyodide/releases/download/{VERSION}/pyodide-core-{VERSION}.tar.bz2",
    "ff3e5f9d9bc8e98ff30b99515535fc24d375994f47a978c61975d653e162ca37",
)
CORE_FILES = ("pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json")
WHEELS = {
    "lxml-6.1.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl": (
        CDN + "lxml-6.1.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
        "6a0b98f57a538cb6af4868c3499efec2bb52f7ed59fed94b7fbf195d6e40281f",
    ),
    "typing_extensions-4.15.0-py3-none-any.whl": (
        CDN + "typing_extensions-4.15.0-py3-none-any.whl",
        "4fec68770a05408e668a4fa53d6bf4f0f684b9dacf820c7c5d6e97d3ad225e29",
    ),
    "python_docx-1.2.0-py3-none-any.whl": (
        "https://files.pythonhosted.org/packages/d0/00/1e03a4989fa5795da308cd774f05b704ace555a70f9bf9d3be057b680bcf/python_docx-1.2.0-py3-none-any.whl",
        "3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7",
    ),
}
LICENSES = {
    "pyodide-MPL-2.0.txt": (
        f"https://raw.githubusercontent.com/pyodide/pyodide/{VERSION}/LICENSE",
        "1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5",
    ),
    "cpython-3.14.2-PSF.txt": (
        "https://raw.githubusercontent.com/python/cpython/v3.14.2/LICENSE",
        "b0e25a78cffb43f4d92de8b61ccfa1f1f98ecbc22330b54b5251e7b6ba010231",
    ),
}
NOTICES = """# Browser runtime notices

These unmodified upstream components allow ZHAI's document layout rules to run
inside the browser worker. The archive for each component is pinned in
`../build_browser_runtime.py`. `SHA256SUMS.txt` covers this runtime directory.

- Pyodide 314.0.8, MPL-2.0: [sources and release](https://github.com/pyodide/pyodide/releases/tag/314.0.8).
- CPython 3.14.2, PSF and bundled licenses: [sources](https://github.com/python/cpython/tree/v3.14.2).
- lxml 6.1.3 and bundled libraries, BSD and additional notices: [sources](https://github.com/lxml/lxml/tree/lxml-6.1.3).
- typing-extensions 4.15.0, PSF: [sources](https://github.com/python/typing_extensions/tree/4.15.0).
- python-docx 1.2.0, MIT: [sources](https://github.com/python-openxml/python-docx/tree/v1.2.0).

The runtime can be rebuilt with `python3 preview/build_browser_runtime.py`.
ZHAI's own layout code remains available under the repository license.
"""


def download(resource):
    url, expected = resource
    with urlopen(url, timeout=40) as response:
        data = response.read(30 * 1024 * 1024 + 1)
    if sha256(data).hexdigest() != expected:
        raise ValueError(f"incorrect SHA256 for {url}")
    return data


def native_helpers():
    source = (ENGINE / "material_workshop_engine.py").read_text(encoding="utf-8")
    syntax = ast.parse(source)
    functions = {node.name: node for node in syntax.body if isinstance(node, ast.FunctionDef)}
    exports = [functions[name] for name in (
        "_set_run_font", "normalize_gongwen_attachment_lists",
        "format_existing_docx_as_gongwen", "clear_docx_metadata",
    )]
    exports.append(next(node for node in functions["process_docx"].body
                        if isinstance(node, ast.FunctionDef) and node.name == "content_signature"))
    code = "# Generated from engine/material_workshop_engine.py.\nimport re\nfrom typing import Any\n\n"
    code += "\n\n".join(dedent(ast.get_source_segment(source, node, padded=True)) for node in exports)
    compile(code, "zhai_layout_helpers.py", "exec")
    return code + "\n"


def main():
    core_name = "pyodide-core.tar.bz2"
    inputs = {core_name: CORE, **WHEELS, **LICENSES}
    with ThreadPoolExecutor(max_workers=5) as pool:
        downloaded = dict(zip(inputs, pool.map(download, inputs.values())))
    with TemporaryDirectory(prefix="zhai-browser-runtime-", dir=PREVIEW) as temp:
        stage = Path(temp)
        with tarfile.open(fileobj=BytesIO(downloaded.pop(core_name)), mode="r:bz2") as archive:
            for name in CORE_FILES:
                member = archive.extractfile(f"pyodide/{name}")
                if member is None:
                    raise ValueError(f"missing core file: {name}")
                (stage / name).write_bytes(member.read())
        wheel_licenses = stage / "licenses"
        wheel_licenses.mkdir()
        for name, contents in downloaded.items():
            if name in LICENSES:
                (wheel_licenses / name).write_bytes(contents)
                continue
            (stage / name).write_bytes(contents)
            with ZipFile(BytesIO(contents)) as wheel:
                for item in wheel.namelist():
                    basename = Path(item).name
                    if basename.upper().startswith(("LICENSE", "COPYING", "NOTICE")):
                        (wheel_licenses / f"{name.split('-')[0]}-{basename}").write_bytes(wheel.read(item))
        (stage / "gongwen_layout.py").write_bytes((ENGINE / "gongwen_layout.py").read_bytes())
        (stage / "zhai_layout_helpers.py").write_text(native_helpers(), encoding="utf-8")
        (stage / "THIRD-PARTY-NOTICES.md").write_text(NOTICES, encoding="utf-8")
        entries = sorted(path for path in stage.rglob("*") if path.is_file())
        (stage / "SHA256SUMS.txt").write_text("".join(
            f"{sha256(path.read_bytes()).hexdigest()}  {path.relative_to(stage).as_posix()}\n" for path in entries
        ), encoding="ascii")
        manifest = json.loads((stage / "pyodide-lock.json").read_text(encoding="utf-8"))
        for package in ("lxml", "typing-extensions"):
            wheel = manifest["packages"][package]
            if WHEELS[wheel["file_name"]][1] != wheel["sha256"]:
                raise ValueError(f"Pyodide lock does not match {package}")
        target = PREVIEW / "runtime"
        target.mkdir(exist_ok=True)
        for path in stage.rglob("*"):
            if path.is_file():
                dest = target / path.relative_to(stage)
                dest.parent.mkdir(parents=True, exist_ok=True)
                path.replace(dest)
    print(f"Built Pyodide {VERSION} runtime in {target}")


if __name__ == "__main__":
    main()
