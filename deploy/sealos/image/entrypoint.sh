#!/bin/bash
set -euo pipefail
umask 077
if [ "$(id -u)" = 0 ]; then
  # Fresh volumes may be owned by root. Only change the mount point itself.
  mkdir -p "$ZHAI_DATA_DIR"
  chown 10001:10001 "$ZHAI_DATA_DIR"
  chmod 700 "$ZHAI_DATA_DIR"
  exec setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs bash /app/zhai/entrypoint.sh
fi
exec bash /app/zhai/entrypoint.sh
