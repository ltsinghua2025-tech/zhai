# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, copy_metadata

# OCR dependencies deliberately live in a separate onefile executable. The
# normal file engine must not extract models/OpenCV/ORT for Word or Excel work.
datas = collect_data_files("rapidocr") + collect_data_files("pypdfium2")
datas += collect_data_files("pypdfium2_raw")
datas += collect_data_files("cv2", includes=["**/LICENSE*", "**/NOTICE*"])
datas += collect_data_files("onnxruntime", includes=["**/LICENSE*", "**/NOTICE*", "**/ThirdPartyNotices*"])
datas += [("OCR_THIRD_PARTY_NOTICES.md", "ocr-licenses")]
for distribution in [
    "rapidocr", "onnxruntime", "opencv-python-headless", "numpy", "Shapely",
    "pypdfium2", "Pillow", "pyclipper", "omegaconf", "PyYAML", "requests",
    "antlr4-python3-runtime", "protobuf", "sympy", "flatbuffers", "coloredlogs",
    "humanfriendly", "six", "tqdm", "colorlog", "packaging", "mpmath",
    "certifi", "charset-normalizer", "idna", "urllib3",
]:
    datas += copy_metadata(distribution)
binaries = collect_dynamic_libs("onnxruntime")
a = Analysis(
    ["rapid_ocr_adapter.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=["rapidocr.inference_engine.onnxruntime", "pypdfium2_raw"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=["linux_crypto_runtime.py"],
    excludes=["tkinter", "torch", "torchvision", "paddle", "openvino", "tensorrt", "matplotlib", "rapid_table"],
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
    pyz, a.scripts, a.binaries, a.datas, [],
    name=os.environ.get("MATERIAL_WORKSHOP_OCR_NAME", "material-workshop-rapid-ocr-aarch64-unknown-linux-gnu"),
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
