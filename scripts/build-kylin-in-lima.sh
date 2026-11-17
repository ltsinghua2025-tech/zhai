#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TOOLS_DIR="$PROJECT_DIR/.tools/lima"
LIMACTL="$TOOLS_DIR/bin/limactl"
INSTANCE=zhai-kylin-focal
LIMA_VERSION=2.2.0

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "该脚本用于在 Apple Silicon Mac 上生成麒麟 ARM64 安装包" >&2
  exit 1
fi

if [ ! -x "$LIMACTL" ]; then
  archive=$(mktemp '/tmp/lima-zhai.XXXXXX.tar.gz')
  trap 'rm -f -- "$archive"' EXIT
  curl -L --fail --retry 3 \
    "https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/lima-${LIMA_VERSION}-Darwin-arm64.tar.gz" \
    -o "$archive"
  mkdir -p "$TOOLS_DIR"
  tar -xzf "$archive" -C "$TOOLS_DIR"
fi

if ! "$LIMACTL" list --format '{{.Name}}' 2>/dev/null | grep -qx "$INSTANCE"; then
  config=$(mktemp '/tmp/zhai-kylin.XXXXXX.yaml')
  trap 'rm -f -- "$config"' EXIT
  python3 - "$SCRIPT_DIR/lima-kylin-builder.yaml" "$config" "$PROJECT_DIR" <<'PY'
import json
import sys
from pathlib import Path

source, target, project = sys.argv[1:]
template = Path(source).read_text(encoding="utf-8")
Path(target).write_text(template.replace('"__ZHAI_PROJECT_DIR__"', json.dumps(project, ensure_ascii=False)), encoding="utf-8")
PY
  "$LIMACTL" start --name "$INSTANCE" "$config"
else
  "$LIMACTL" start "$INSTANCE" >/dev/null 2>&1 || true
fi

"$LIMACTL" shell "$INSTANCE" bash -lc '
  set -euo pipefail
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    build-essential curl ca-certificates file xz-utils pkg-config patchelf \
    libwebkit2gtk-4.0-dev libgtk-3-dev librsvg2-dev libssl-dev \
    libayatana-appindicator3-dev libdbus-1-dev xdg-utils antiword dpkg-dev \
    meson ninja-build libcap-dev

  tool_root="$HOME/.local/zhai-build"
  mkdir -p "$tool_root"
  if [ ! -x "$tool_root/node/bin/node" ]; then
    curl -L --fail --retry 3 \
      https://nodejs.org/dist/latest-v22.x/node-v22.23.2-linux-arm64.tar.xz \
      -o /tmp/zhai-node.tar.xz
    mkdir -p "$tool_root/node"
    tar -xJf /tmp/zhai-node.tar.xz --strip-components=1 -C "$tool_root/node"
  fi
  if [ ! -x "$tool_root/python/bin/python3" ]; then
    curl -L --fail --retry 3 \
      "https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-aarch64-unknown-linux-gnu-install_only.tar.gz" \
      -o /tmp/zhai-python.tar.gz
    mkdir -p "$tool_root/python"
    tar -xzf /tmp/zhai-python.tar.gz --strip-components=1 -C "$tool_root/python"
  fi
  if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
    curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  fi
  export PATH="$tool_root/node/bin:$tool_root/python/bin:$HOME/.cargo/bin:$PATH"
  cd "$1"
  unset ZHAI_CITIZEN_KNOWLEDGE_DIR
  npm install --ignore-scripts
  sh scripts/fetch-officecli.sh
  sh scripts/fetch-codex.sh
  sh scripts/verify-codex-resources.sh
  sh scripts/build-bwrap-kylin.sh

  binary_dir="$PWD/src-tauri/binaries"
  install -Dm755 /usr/bin/antiword \
    "$binary_dir/zhai-antiword-aarch64-unknown-linux-gnu"
  install -Dm644 /usr/share/antiword/UTF-8.txt \
    "$binary_dir/antiword-data/UTF-8.txt"
  install -Dm644 /usr/share/antiword/fontnames \
    "$binary_dir/antiword-data/fontnames"
  install -Dm644 /usr/share/doc/antiword/copyright \
    "$binary_dir/Antiword-COPYRIGHT.txt"
  install -Dm644 /usr/share/common-licenses/GPL-2 \
    "$binary_dir/Antiword-GPL-2.txt"

  source_dir="$binary_dir/antiword-source"
  if [ ! -f "$source_dir/antiword_0.37.orig.tar.gz" ]; then
    echo "deb-src http://ports.ubuntu.com/ubuntu-ports focal universe" | \
      sudo tee /etc/apt/sources.list.d/zhai-antiword-src.list >/dev/null
    sudo apt-get update
    download_dir=$(mktemp -d /tmp/zhai-antiword-source.XXXXXX)
    (
      cd "$download_dir"
      apt-get source --download-only antiword=0.37-16
    )
    mkdir -p "$source_dir"
    install -m644 "$download_dir/antiword_0.37-16.dsc" "$source_dir/"
    install -m644 "$download_dir/antiword_0.37-16.debian.tar.xz" "$source_dir/"
    install -m644 "$download_dir/antiword_0.37.orig.tar.gz" "$source_dir/"
    rm -rf "$download_dir"
  fi

  PYTHON3_BIN="$tool_root/python/bin/python3" sh scripts/build-sidecar-kylin.sh
  PYTHON3_BIN="$tool_root/python/bin/python3" sh scripts/build-rapid-ocr-kylin.sh
  cd src-tauri-kylin
  npx --yes @tauri-apps/cli@1.6.3 build --bundles deb
  version=$(node -p "require(\"./tauri.conf.json\").package.version")
  deb="target/release/bundle/deb/zhai_${version}_arm64.deb"
  test -f "$deb"
  if dpkg-deb -f "$deb" Depends | grep -qi libreoffice; then
    echo "麒麟安装包意外引入 LibreOffice 依赖，已停止交付" >&2
    exit 1
  fi
  dpkg-deb --info "$deb"
  sha256sum "$deb"
  python3 ../scripts/package-kylin-components.py \
    --main-deb "$deb" \
    --ocr-binary ../src-tauri/binaries/material-workshop-rapid-ocr-aarch64-unknown-linux-gnu \
    --output-dir target/release/bundle/split-deb
' zhai-kylin "$PROJECT_DIR"

find "$PROJECT_DIR/src-tauri-kylin/target/release/bundle/split-deb" -maxdepth 1 -name '*.deb' -type f -print
