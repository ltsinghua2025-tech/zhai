# -*- mode: python ; coding: utf-8 -*-

import os

from PyInstaller.utils.hooks import collect_data_files

# python-docx resolves some resources via parts/../templates. Frozen Python
# modules alone do not create the parts directory, so include its source tree
# as well as data; otherwise header/footer creation fails after packaging.
datas = collect_data_files("docx", include_py_files=True) + collect_data_files("reportlab") + collect_data_files("docxcompose")
excluded_modules = ["tkinter"]

a = Analysis(
    ["material_workshop_engine.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=["docx", "openpyxl", "pdfplumber", "pypdf", "reportlab"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=["linux_crypto_runtime.py"],
    excludes=excluded_modules,
    noarchive=False,
)
from pathlib import Path
import sys
sys.path.insert(0, str(Path(SPECPATH).parent / "scripts"))
from slim_frozen_runtime import prepare_analysis
from PyInstaller.config import CONF
prepare_analysis(a, CONF["workpath"])
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name=os.environ.get("MATERIAL_WORKSHOP_ENGINE_NAME", "material-workshop-engine-aarch64-apple-darwin"),
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
