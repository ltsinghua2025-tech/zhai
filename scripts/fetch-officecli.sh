#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
VERSION=1.0.144

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    ASSET=officecli-mac-arm64
    TARGET=officecli-aarch64-apple-darwin
    EXPECTED=04757163428c5bde8d91e8f838517818e74722157722ca5f3877b6716b77bd45
    ;;
  Linux-aarch64|Linux-arm64)
    ASSET=officecli-linux-arm64
    TARGET=officecli-aarch64-unknown-linux-gnu
    EXPECTED=56ec2c3114b66f6490888b6778cbb8413a65911a26cacc7207f29e13424966da
    ;;
  *)
    echo "OfficeCLI 暂未为当前构建平台提供固定组件：$(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

DESTINATION="$PROJECT_DIR/src-tauri/binaries/$TARGET"
LICENSE_DESTINATION="$PROJECT_DIR/src-tauri/binaries/OfficeCLI-LICENSE.txt"
NOTICES_DESTINATION="$PROJECT_DIR/src-tauri/binaries/OfficeCLI-THIRD-PARTY-NOTICES.txt"
if [ -x "$DESTINATION" ]; then
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$DESTINATION" | awk '{print $1}')
  else
    ACTUAL=$(sha256sum "$DESTINATION" | awk '{print $1}')
  fi
  if [ "$ACTUAL" = "$EXPECTED" ]; then
    if [ ! -f "$LICENSE_DESTINATION" ]; then
      curl -L --fail --retry 3 "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/v${VERSION}/LICENSE" -o "$LICENSE_DESTINATION"
    fi
    if [ ! -f "$NOTICES_DESTINATION" ]; then
      curl -L --fail --retry 3 "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/v${VERSION}/THIRD-PARTY-NOTICES.txt" -o "$NOTICES_DESTINATION"
    fi
    echo "OfficeCLI $VERSION 已就绪：$DESTINATION"
    exit 0
  fi
fi

TEMP=$(mktemp '/tmp/zhai-officecli.XXXXXX')
trap 'rm -f -- "$TEMP"' EXIT
curl -L --fail --retry 3 \
  "https://github.com/iOfficeAI/OfficeCLI/releases/download/v${VERSION}/${ASSET}" \
  -o "$TEMP"
if command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$TEMP" | awk '{print $1}')
else
  ACTUAL=$(sha256sum "$TEMP" | awk '{print $1}')
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "OfficeCLI 校验失败：期望 $EXPECTED，实际 $ACTUAL" >&2
  exit 1
fi
mkdir -p "$(dirname "$DESTINATION")"
cp "$TEMP" "$DESTINATION"
chmod 755 "$DESTINATION"
curl -L --fail --retry 3 "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/v${VERSION}/LICENSE" -o "$LICENSE_DESTINATION"
curl -L --fail --retry 3 "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/v${VERSION}/THIRD-PARTY-NOTICES.txt" -o "$NOTICES_DESTINATION"
echo "OfficeCLI $VERSION 已安装到构建目录：$DESTINATION"
