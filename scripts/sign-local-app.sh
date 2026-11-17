#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
APP_PATH="$PROJECT_DIR/src-tauri/target/release/bundle/macos/zhai.app"
ENTITLEMENTS="$PROJECT_DIR/src-tauri/sidecar-entitlements.plist"

codesign --force --sign - --options runtime --timestamp=none \
  --entitlements "$ENTITLEMENTS" \
  "$APP_PATH/Contents/MacOS/material-workshop-engine"
codesign --force --sign - --options runtime --timestamp=none \
  "$APP_PATH/Contents/MacOS/material-workshop-vision-ocr"
# OfficeCLI release binary already carries its publisher's Developer ID signature.
# Re-signing the .NET single-file executable breaks its embedded runtime payload,
# so preserve and verify the upstream signature instead.
codesign --verify --strict --verbose=2 \
  "$APP_PATH/Contents/MacOS/officecli"
# The official Codex release is signed by OpenAI. Preserve its Developer ID
# signature so users can verify the embedded Harness came from OpenAI.
codesign --verify --strict --verbose=2 \
  "$APP_PATH/Contents/MacOS/codex"
codesign --force --sign - --options runtime --timestamp=none \
  "$APP_PATH/Contents/MacOS/material-workshop-desktop"
# Keep the designated requirement stable across local builds. Without an
# explicit requirement, ad-hoc signing falls back to a changing CDHash and
# macOS Keychain asks the user to authorize the same app after every update.
codesign --force --sign - --options runtime --timestamp=none \
  --requirements '=designated => identifier "cn.materialworkbench.desktop"' \
  "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
