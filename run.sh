#!/usr/bin/env bash
# Start the whole app.
#
#   ./run.sh            # dev: server (tsx watch) + web (vite) with proxy; Ctrl-C stops both
#   ./run.sh prod       # build the web app, then serve it from the server on one port
#
# Reads .env (see .env.example). Honors IMAGINATOR_PORT (default 4747) and
# IMAGINATOR_DATA_DIR. The mock provider is on automatically when no real
# provider key is set.
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-dev}"

# Load .env without overriding variables already set in the shell.
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="${key#export }"; key="${key%"${key##*[![:space:]]}"}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [ -z "${!key:-}" ]; then export "$key=$val"; fi
  done < .env
fi

PORT="${IMAGINATOR_PORT:-4747}"
export IMAGINATOR_PORT="$PORT"
export IMAGINATOR_SERVER_URL="http://localhost:$PORT"

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
if [ ! -d node_modules ]; then
  echo "▸ installing dependencies"
  pnpm install
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✖ port $PORT is already in use:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  echo "  set IMAGINATOR_PORT to a free port (e.g. IMAGINATOR_PORT=4322 ./run.sh)" >&2
  exit 1
fi

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

case "$MODE" in
  dev)
    echo "▸ server on http://localhost:$PORT, web on http://localhost:5173 (proxying /api and /assets)"
    pnpm --filter @imaginator/server dev &
    PIDS+=($!)
    pnpm --filter @imaginator/web dev &
    PIDS+=($!)
    wait -n 2>/dev/null || wait
    ;;
  prod)
    echo "▸ building web"
    pnpm --filter @imaginator/web build
    echo "▸ serving app on http://localhost:$PORT"
    pnpm --filter @imaginator/server start &
    PIDS+=($!)
    wait
    ;;
  *)
    echo "usage: $0 [dev|prod]" >&2
    exit 2
    ;;
esac
