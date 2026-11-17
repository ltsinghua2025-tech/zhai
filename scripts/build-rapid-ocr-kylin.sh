#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENGINE_DIR="$PROJECT_DIR/engine"
VENV_DIR="$ENGINE_DIR/.venv-ocr-kylin"
PYTHON3_BIN=${PYTHON3_BIN:-python3}
[ "$(uname -s)-$(uname -m)" = Linux-aarch64 ] || { echo "请在 Linux ARM64 构建 OCR" >&2; exit 1; }
"$PYTHON3_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python3" -m pip install -r "$ENGINE_DIR/requirements-ocr.txt" pyinstaller==6.15.0
(
  cd "$ENGINE_DIR"
  OPENSSL_armcap=0 MATERIAL_WORKSHOP_SLIM_LINUX=1 MATERIAL_WORKSHOP_OCR_NAME=material-workshop-rapid-ocr-aarch64-unknown-linux-gnu \
    "$VENV_DIR/bin/pyinstaller" --clean --noconfirm --workpath build-ocr-kylin \
    --distpath dist-ocr-kylin material-workshop-rapid-ocr.spec
)
target="$PROJECT_DIR/src-tauri/binaries/material-workshop-rapid-ocr-aarch64-unknown-linux-gnu"
cp "$ENGINE_DIR/dist-ocr-kylin/material-workshop-rapid-ocr-aarch64-unknown-linux-gnu" "$target.new"
chmod 755 "$target.new"
mv -f "$target.new" "$target"
"$target" --probe
