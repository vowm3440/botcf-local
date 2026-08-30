#!/usr/bin/env bash
# Multi-architecture release gate for the container image.
#
# The arm64 image passed every check it had and was still broken: /health
# answered, `omp --version` printed a version, and the agent runtime was dead —
# the RPC handshake had timed out and the server had fallen back to direct mode.
# Both of those green signals are upstream of the thing that matters, so this
# gate asserts the thing that matters and nothing weaker:
#
#     /api/omp/status → running: true, protocolError: null
#
# It also prints the spawn → ready percentiles the server now records, because
# the handshake budget in apps/server/src/omp/startupBudget.ts is supposed to be
# set from those numbers rather than guessed.
#
#   ci/verify-docker-omp.sh                      # host architecture
#   ci/verify-docker-omp.sh linux/arm64          # emulated, on an x64 host
#   PLATFORMS="linux/amd64 linux/arm64" ci/verify-docker-omp.sh
#
# An emulated run needs binfmt handlers registered (Docker Desktop ships them;
# elsewhere: `docker run --privileged --rm tonistiigi/binfmt --install all`).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORMS="${PLATFORMS:-${*:-}}"
[ -n "$PLATFORMS" ] || PLATFORMS="linux/amd64"

HOST_PORT="${HOST_PORT:-17788}"
# The agent binary is downloaded and installed on first start; under emulation
# that is slow enough to need saying out loud.
INSTALL_TIMEOUT="${INSTALL_TIMEOUT:-900}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

say() { printf '[gate] %s\n' "$*"; }
fail() { printf '[gate] FAIL  %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker 不在 PATH 中"

CONTAINER=""
VOLUME=""
IMAGE=""

cleanup() {
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [ -n "$VOLUME" ] && docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  [ -n "$IMAGE" ] && docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
  CONTAINER=""; VOLUME=""; IMAGE=""
}
trap cleanup EXIT INT TERM

# `docker exec` rather than a host request: the port mapping is not the subject
# under test, and wget is already in the image.
probe() {
  docker exec "$CONTAINER" wget -qO- "http://127.0.0.1:7788$1" 2>/dev/null
}

# Reads one field out of the status JSON without assuming jq is installed.
json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p" | head -n 1 | tr -d ' "'
}

verify_platform() {
  local platform="$1"
  local slug
  slug="$(printf '%s' "$platform" | tr '/' '-')"
  IMAGE="botcf-gate:$slug"
  VOLUME="botcf-gate-$slug"
  CONTAINER="botcf-gate-$slug"

  say "── $platform ──"
  say "构建镜像 $IMAGE"
  docker build --platform "$platform" -f "$REPO_ROOT/docker/Dockerfile" -t "$IMAGE" "$REPO_ROOT" \
    || fail "$platform 镜像构建失败"

  # The image runs as 1001 against a read-only root filesystem, so /data has to
  # be writable by that uid before the entrypoint creates $HOME in it.
  docker volume create "$VOLUME" >/dev/null
  docker run --rm --platform "$platform" --user 0:0 -v "$VOLUME:/data" "$IMAGE" \
    chown -R 1001:1001 /data >/dev/null || fail "$platform 无法准备 /data 卷"

  say "启动容器(只读根文件系统,用户 1001)"
  docker run -d --name "$CONTAINER" --platform "$platform" \
    --read-only --tmpfs /tmp \
    --user 1001:1001 --security-opt no-new-privileges:true --cap-drop ALL \
    -v "$VOLUME:/data" \
    -p "127.0.0.1:$HOST_PORT:7788" \
    "$IMAGE" >/dev/null || fail "$platform 容器启动失败"

  say "等待 /health(≤ ${HEALTH_TIMEOUT}s)"
  local waited=0
  until probe /health >/dev/null 2>&1; do
    waited=$((waited + 3)); sleep 3
    if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
      docker logs --tail 50 "$CONTAINER" >&2 || true
      fail "$platform 在 ${HEALTH_TIMEOUT}s 内没有响应 /health"
    fi
  done
  say "/health 就绪(${waited}s)—— 但这不是通过条件"

  say "等待 OMP 自动安装并完成 RPC 握手(≤ ${INSTALL_TIMEOUT}s)"
  waited=0
  local status running protocol_error available
  while :; do
    status="$(probe /api/omp/status || true)"
    running="$(json_field "$status" running)"
    protocol_error="$(json_field "$status" protocolError)"
    available="$(json_field "$status" available)"
    [ "$running" = "true" ] && break
    if [ "$waited" -ge "$INSTALL_TIMEOUT" ]; then
      say "最后一次 /api/omp/status:"
      printf '%s\n' "$status" >&2
      docker logs --tail 80 "$CONTAINER" >&2 || true
      fail "$platform: running=$running available=$available protocolError=$protocol_error —— HTTP 健康不等于运行时可用"
    fi
    waited=$((waited + 5)); sleep 5
  done

  [ "$protocol_error" = "null" ] || fail "$platform: running=true 但 protocolError=$protocol_error"

  # The measurement the handshake budget should be argued from.
  local profile ready_timeout last_ready
  profile="$(json_field "$status" profile)"
  ready_timeout="$(json_field "$status" readyTimeoutMs)"
  last_ready="$(json_field "$status" lastReadyMs)"
  say "PASS  $platform: running=true, protocolError=null"
  say "      启动画像 $profile · ready 预算 ${ready_timeout}ms · 实测 spawn→ready ${last_ready}ms"
  say "      startup 区块原文:"
  printf '%s\n' "$status" | tr ',' '\n' | grep -E 'profile|ReadyMs|TimeoutMs|p50|p95|samples' || true

  cleanup
}

for platform in $PLATFORMS; do
  verify_platform "$platform"
done

say ""
say "多架构门禁: PASS — $PLATFORMS"
