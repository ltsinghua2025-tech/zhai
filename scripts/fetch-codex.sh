#!/bin/sh
# Pinned official Harness; never updates the user's global Codex installation.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
VERSION=0.163.0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    asset=codex-aarch64-apple-darwin
    target=aarch64-apple-darwin
    archive_hash=61c4d9a92521bdb42b0c1d9f87c673f6da628a06de5945cbdd9a0010632f6d10
    binary_hash=8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31
    ;;
  Linux-aarch64)
    asset=codex-aarch64-unknown-linux-musl
    # Tauri names sidecars by its host target; the contents remain official musl.
    target=aarch64-unknown-linux-gnu
    archive_hash=a7261e65f4a96d8f4ca65a069c6cf2dc2c33defc341e48078acefda9461fffe4
    binary_hash=8a96f66d059d653e68bfd5f3c79337e6f1d7d170d80bf705eb7d0249b34c0ece
    ;;
  *) echo "Codex 包仅支持 macOS Apple Silicon 和 Linux ARM64" >&2; exit 1 ;;
esac
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}
destination="$PROJECT_DIR/src-tauri/binaries/codex-$target"
if [ -f "$destination" ] && [ "$(digest "$destination")" = "$binary_hash" ]; then
  echo "Codex $VERSION 已就绪（校验通过）"; exit 0
fi
stage=$(mktemp -d /tmp/zhai-codex.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT
curl -fL --retry 3 "https://github.com/openai/codex/releases/download/rust-v$VERSION/$asset.tar.gz" -o "$stage/release.tar.gz"
[ "$(digest "$stage/release.tar.gz")" = "$archive_hash" ] || { echo "Codex 下载校验失败" >&2; exit 1; }
tar -xzf "$stage/release.tar.gz" -C "$stage" "$asset"
[ "$(digest "$stage/$asset")" = "$binary_hash" ] || { echo "Codex 二进制校验失败" >&2; exit 1; }
if [ "$(uname -s)" = Darwin ]; then codesign --verify --strict "$stage/$asset"; fi
[ "$("$stage/$asset" --version)" = "codex-cli $VERSION" ] || { echo "Codex 运行版本不符" >&2; exit 1; }
mkdir -p "$(dirname "$destination")"
cp "$stage/$asset" "$destination.new"
chmod 755 "$destination.new"
mv -f "$destination.new" "$destination"
echo "Codex $VERSION 已就绪：$target"
