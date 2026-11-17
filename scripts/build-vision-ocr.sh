#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SOURCE="$PROJECT_DIR/native/vision-ocr/main.swift"
TARGET="$PROJECT_DIR/src-tauri/binaries/material-workshop-vision-ocr-aarch64-apple-darwin"

xcrun swiftc "$SOURCE" \
  -O \
  -framework AppKit \
  -framework PDFKit \
  -framework Vision \
  -o "$TARGET"
chmod 755 "$TARGET"
echo "Vision OCR ready: $TARGET"
