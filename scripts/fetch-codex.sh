#!/bin/sh
# Pinned official Harness; never updates the user's global Codex installation.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
VERSION=0.171.0
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    asset=codex-aarch64-apple-darwin
    target=aarch64-apple-darwin
    archive_hash=9414c8c967f110b11e8324c0cfa2b20f012094ef890110a561c92ee535a2681a
    binary_hash=fc8d77cf7585aded2b9bc487dad29c4ee2f066123e4e76dd3b17653a8322ce42
    ;;
  Linux-aarch64)
    asset=codex-aarch64-unknown-linux-musl
    # Tauri names sidecars by its host target; the contents remain official musl.
    target=aarch64-unknown-linux-gnu
    archive_hash=bcf50b836385e51bd2976ab2bbe92b1b08a1cbe37712eb8dbe378aa78d24871c
    binary_hash=9ba12ec7712e2905b2ea00791f4ebddc9528629cc955d11d25272de445e10643
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
