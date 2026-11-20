#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export ZHAI_CONFIG_FILE="${ZHAI_CONFIG_FILE:-$PWD/private-config.json}"
export ZHAI_DATA_DIR="${ZHAI_DATA_DIR:-$PWD/data}"
export ZHAI_WEB_HOST=0.0.0.0
export ZHAI_WEB_PORT="${ZHAI_WEB_PORT:-8080}"
export PYTHONUNBUFFERED=1
# Conservative CPU dispatch for older ARM64 virtual machines; TLS stays enabled.
case "$(uname -m)" in aarch64|arm64) export OPENSSL_armcap="${OPENSSL_armcap:-0}" ;; esac
if [ ! -x .venv/bin/python3 ]; then
  echo "尚未安装，请先执行 bash setup.sh"; exit 1
fi
python3 verify-package.py
exec .venv/bin/python3 server/app.py
