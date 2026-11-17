#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENGINE_DIR="$PROJECT_DIR/engine"
VENV_DIR="$ENGINE_DIR/.venv-build"
TARGET_DIR="$PROJECT_DIR/src-tauri/binaries"
PYTHON3_BIN=${PYTHON3_BIN:-python3}

"$PYTHON3_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python3" -m pip install --upgrade pip
"$VENV_DIR/bin/python3" -m pip install -r "$ENGINE_DIR/requirements.txt" pyinstaller==6.15.0
(
  cd "$ENGINE_DIR"
  "$VENV_DIR/bin/pyinstaller" --clean --noconfirm material-workshop-engine.spec
)
mkdir -p "$TARGET_DIR"
cp "$ENGINE_DIR/dist/material-workshop-engine-aarch64-apple-darwin" \
  "$TARGET_DIR/material-workshop-engine-aarch64-apple-darwin.new"
chmod 755 "$TARGET_DIR/material-workshop-engine-aarch64-apple-darwin.new"
# Replacing the inode avoids macOS retaining the old executable's code-signing cache.
mv -f "$TARGET_DIR/material-workshop-engine-aarch64-apple-darwin.new" \
  "$TARGET_DIR/material-workshop-engine-aarch64-apple-darwin"
echo "Sidecar ready: $TARGET_DIR/material-workshop-engine-aarch64-apple-darwin"
