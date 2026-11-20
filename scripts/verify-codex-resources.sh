#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR/src-tauri/binaries/codex-resources"
version=0.171.0
source_file="source/codex-rust-v$version-source.tar.gz"
check() {
  actual=$(sha256sum "$1" | cut -d ' ' -f 1)
  [ "$actual" = "$2" ] || { echo "Codex 隔离组件或对应源码校验失败：$1" >&2; exit 1; }
}
if [ ! -x bwrap ] || [ ! -s "$source_file" ]; then
  stage=$(mktemp -d /tmp/zhai-codex-resources.XXXXXX)
  trap 'rm -rf -- "$stage"' EXIT
  curl -fLsS --retry 3 "https://github.com/openai/codex/releases/download/rust-v$version/bwrap-aarch64-unknown-linux-musl.tar.gz" -o "$stage/bwrap.tar.gz"
  curl -fLsS --retry 3 "https://codeload.github.com/openai/codex/tar.gz/refs/tags/rust-v$version" -o "$stage/codex-source.tar.gz"
  check "$stage/bwrap.tar.gz" bfafa334e99119c5dcedc437e123de8605b3f8f615f43af793226ab51d57d9f2
  check "$stage/codex-source.tar.gz" fd77744299602d6663fe2ace84fc338b33a23a3b125a691757c31ea8c58e5217
  tar -xzf "$stage/bwrap.tar.gz" -C "$stage" bwrap-aarch64-unknown-linux-musl
  check "$stage/bwrap-aarch64-unknown-linux-musl" f5065eb8b9ddd9c89cac0ce79ed1aafab5841c7d9c3e73674c94724d6bf8f7c0
  install -m755 "$stage/bwrap-aarch64-unknown-linux-musl" bwrap
  install -Dm644 "$stage/codex-source.tar.gz" "$source_file"
fi
check bwrap f5065eb8b9ddd9c89cac0ce79ed1aafab5841c7d9c3e73674c94724d6bf8f7c0
check "$source_file" fd77744299602d6663fe2ace84fc338b33a23a3b125a691757c31ea8c58e5217
test -s Bubblewrap-COPYING.txt
test -s Bubblewrap-LICENSE.txt
test -x bwrap
