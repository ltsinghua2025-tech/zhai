#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BINARY_DIR="$PROJECT_DIR/src-tauri/binaries"
VERSION=0.12.0
SOURCE_SHA256=3f66d9e3f85396f6d7d7fbd2859f277e4fd3a9303341bfe2ff325251bda65fd4
SOURCE_DIR="$BINARY_DIR/bubblewrap-source"
ARCHIVE="$SOURCE_DIR/bubblewrap-$VERSION.tar.gz"

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = aarch64 ] || {
  echo "必须在 ARM64 Linux 上构建隔离器" >&2
  exit 1
}
mkdir -p "$SOURCE_DIR"
if [ ! -f "$ARCHIVE" ]; then
  curl -L --fail --retry 3 "https://github.com/containers/bubblewrap/archive/refs/tags/v$VERSION.tar.gz" -o "$ARCHIVE"
fi
echo "$SOURCE_SHA256  $ARCHIVE" | sha256sum -c -
# Upstream tests mount a tmpfs at /tmp; keep their Python helper outside it.
mkdir -p "$PROJECT_DIR/.build"
BUILD_DIR=$(mktemp -d "$PROJECT_DIR/.build/zhai-bwrap-build.XXXXXX")
trap 'rm -rf -- "$BUILD_DIR"' EXIT
tar -xzf "$ARCHIVE" -C "$BUILD_DIR"
SOURCE_TREE="$BUILD_DIR/bubblewrap-$VERSION"
# Test-only repair: upstream ctypes allocated 16 bytes for a full statfs write.
# This patch does not change any executable source or sandbox behavior.
patch -p1 -d "$SOURCE_TREE" < "$SCRIPT_DIR/patches/bubblewrap-0.12.0-test-statfs.patch"
# Keep the fallback for kernel 5.4; never set assume_kernel to a newer kernel.
meson setup "$BUILD_DIR/build" "$SOURCE_TREE" \
  --buildtype=release -Dman=disabled -Dtests=true -Dselinux=disabled \
  -Dbash_completion=disabled -Dzsh_completion=disabled
ninja -C "$BUILD_DIR/build"
meson test -C "$BUILD_DIR/build" --print-errorlogs
install -m644 "$BUILD_DIR/build/meson-logs/testlog.txt" "$SOURCE_DIR/upstream-testlog.txt"
install -m755 "$BUILD_DIR/build/bwrap" "$BINARY_DIR/zhai-bwrap-aarch64-unknown-linux-gnu"
install -m644 "$SOURCE_TREE/COPYING" "$BINARY_DIR/Bubblewrap-LGPL-2.1.txt"
install -m644 "$SCRIPT_DIR/build-bwrap-kylin.sh" "$SOURCE_DIR/build-bwrap-kylin.sh"
install -m644 "$SCRIPT_DIR/patches/bubblewrap-0.12.0-test-statfs.patch" "$SOURCE_DIR/test-statfs.patch"
"$BINARY_DIR/zhai-bwrap-aarch64-unknown-linux-gnu" --version
