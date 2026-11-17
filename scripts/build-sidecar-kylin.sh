#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENGINE_DIR="$PROJECT_DIR/engine"
VENV_DIR="$ENGINE_DIR/.venv-build-kylin"
TARGET_DIR="$PROJECT_DIR/src-tauri/binaries"
PYTHON3_BIN=${PYTHON3_BIN:-python3}

[ "$(uname -s)" = "Linux" ] || { echo "必须在 Linux 中构建麒麟 sidecar" >&2; exit 1; }
[ "$(uname -m)" = "aarch64" ] || { echo "必须在 ARM64 Linux 中构建" >&2; exit 1; }

"$PYTHON3_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python3" -m pip install --upgrade pip
"$VENV_DIR/bin/python3" -m pip install -r "$ENGINE_DIR/requirements.txt" pyinstaller==6.15.0
(
  cd "$ENGINE_DIR"
  OPENSSL_armcap=0 MATERIAL_WORKSHOP_SLIM_LINUX=1 MATERIAL_WORKSHOP_ENGINE_NAME=material-workshop-engine-aarch64-unknown-linux-gnu \
    "$VENV_DIR/bin/pyinstaller" --clean --noconfirm --workpath build-kylin material-workshop-engine.spec
)
mkdir -p "$TARGET_DIR"
cp "$ENGINE_DIR/dist/material-workshop-engine-aarch64-unknown-linux-gnu" \
  "$TARGET_DIR/material-workshop-engine-aarch64-unknown-linux-gnu.new"
chmod 755 "$TARGET_DIR/material-workshop-engine-aarch64-unknown-linux-gnu.new"
mv -f "$TARGET_DIR/material-workshop-engine-aarch64-unknown-linux-gnu.new" \
  "$TARGET_DIR/material-workshop-engine-aarch64-unknown-linux-gnu"
echo "Kylin sidecar ready: $TARGET_DIR/material-workshop-engine-aarch64-unknown-linux-gnu"
