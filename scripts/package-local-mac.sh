#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
APP_PATH="$PROJECT_DIR/src-tauri/target/release/bundle/macos/zhai.app"
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
DMG_PATH="$PROJECT_DIR/src-tauri/target/release/bundle/dmg/zhai_${VERSION}_aarch64.dmg"
STAGE=$(mktemp -d '/tmp/material-workbench-dmg.XXXXXX')
PACKAGE_RUNNER=${PACKAGE_RUNNER:-npm}

if ! command -v "$PACKAGE_RUNNER" >/dev/null 2>&1; then
  if command -v pnpm >/dev/null 2>&1; then
    PACKAGE_RUNNER=pnpm
  else
    echo "未找到 npm 或 pnpm，无法构建 Mac 安装包" >&2
    exit 1
  fi
fi

case "$STAGE" in
  /tmp/material-workbench-dmg.*) ;;
  *) echo "拒绝使用非预期临时目录：$STAGE" >&2; exit 1 ;;
esac
trap 'rm -rf -- "$STAGE"' EXIT

cd "$PROJECT_DIR"
if [ "${SKIP_APP_BUILD:-0}" != "1" ]; then
  sh scripts/fetch-codex.sh
  "$PACKAGE_RUNNER" run fetch:officecli
  "$PACKAGE_RUNNER" run build:sidecar
  "$PACKAGE_RUNNER" run build:ocr
  case "$PACKAGE_RUNNER" in
    *pnpm)
    "$PACKAGE_RUNNER" run tauri build --bundles app --config '{"build":{"beforeBuildCommand":"pnpm run build"}}'
    ;;
    *)
    "$PACKAGE_RUNNER" run tauri -- build --bundles app
    ;;
  esac
  "$PACKAGE_RUNNER" run sign:local
fi

mkdir -p "$(dirname "$DMG_PATH")"
cp -R "$APP_PATH" "$STAGE/zhai.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create \
  -volname "zhai" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG_PATH"
hdiutil verify "$DMG_PATH"
shasum -a 256 "$DMG_PATH"
