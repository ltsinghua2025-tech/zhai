#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR/src-tauri/binaries/codex-resources"
version=0.163.0
check() {
  actual=$(sha256sum "$1" | cut -d ' ' -f 1)
  [ "$actual" = "$2" ] || { echo "Codex 隔离组件或对应源码校验失败：$1" >&2; exit 1; }
}
if [ ! -x bwrap ] || [ ! -s source/codex-rust-v0.163.0-source.tar.gz ]; then
  stage=$(mktemp -d /tmp/zhai-codex-resources.XXXXXX)
  trap 'rm -rf -- "$stage"' EXIT
  curl -fLsS --retry 3 "https://github.com/openai/codex/releases/download/rust-v$version/bwrap-aarch64-unknown-linux-musl.tar.gz" -o "$stage/bwrap.tar.gz"
  curl -fLsS --retry 3 "https://codeload.github.com/openai/codex/tar.gz/refs/tags/rust-v$version" -o "$stage/codex-source.tar.gz"
  check "$stage/bwrap.tar.gz" 953647c6f8c8adc1b8fc6534ff283bf95e6ba0230274a70a9eda33bb2c8e6a82
  check "$stage/codex-source.tar.gz" 5990ddb133184ce5e470c741d14f1eeb24a0b6cd36685ef78fb772cf83cab7fc
  tar -xzf "$stage/bwrap.tar.gz" -C "$stage" bwrap-aarch64-unknown-linux-musl
  check "$stage/bwrap-aarch64-unknown-linux-musl" c547cbdc762a70ed216789ffaa4c6c0e7d2beabe32245a498f8e365a9fc8dab4
  install -m755 "$stage/bwrap-aarch64-unknown-linux-musl" bwrap
  install -Dm644 "$stage/codex-source.tar.gz" source/codex-rust-v0.163.0-source.tar.gz
fi
check bwrap c547cbdc762a70ed216789ffaa4c6c0e7d2beabe32245a498f8e365a9fc8dab4
check source/codex-rust-v0.163.0-source.tar.gz 5990ddb133184ce5e470c741d14f1eeb24a0b6cd36685ef78fb772cf83cab7fc
test -s Bubblewrap-COPYING.txt
test -s Bubblewrap-LICENSE.txt
test -x bwrap
