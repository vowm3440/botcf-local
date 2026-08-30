#!/bin/sh
# The root filesystem is read-only and /data is a bind mount created by the
# host, so $HOME cannot be baked into the image — it has to exist before the
# server starts. OMP unpacks its native addon under $HOME/.omp; a missing or
# unwritable HOME fails the RPC handshake while /health still answers ok.
set -e

HOME_DIR="${HOME:-/data/home}"
if ! mkdir -p "$HOME_DIR" 2>/dev/null; then
  echo "[entrypoint] 无法创建 HOME 目录 $HOME_DIR:请确认 /data 挂载可写(容器用户 1001:1001)" >&2
  exit 1
fi
if [ ! -w "$HOME_DIR" ]; then
  echo "[entrypoint] HOME 目录 $HOME_DIR 不可写:请把宿主 data 目录的属主改为 1001:1001" >&2
  exit 1
fi

exec "$@"
