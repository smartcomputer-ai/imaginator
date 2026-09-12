#!/usr/bin/env bash
# Imaginator control script (containerised dev deployment).
#
#   ./ctl.sh status     # is it up, healthy, and reachable?
#   ./ctl.sh logs       # follow logs
#   ./ctl.sh web        # rebuild the web bundle (needed after packages/web edits)
#   ./ctl.sh restart    # restart the container
#   ./ctl.sh up         # start (after a VM boot this should already be automatic)
#   ./ctl.sh down       # stop and remove the container
#   ./ctl.sh shell      # shell inside the container
#   ./ctl.sh reinstall  # wipe node_modules volumes and reinstall (after dependency changes)
#
# Server edits (packages/server, packages/core) hot-reload in ~4s, no action needed.
set -euo pipefail
cd "$(dirname "$0")"

# Public URL of this deployment, if it is exposed. Override per environment:
#   export IMAGINATOR_PUBLIC_URL=https://<your-ingress-host>
URL="${IMAGINATOR_PUBLIC_URL:-http://127.0.0.1:8080}"

case "${1:-status}" in
  status)
    docker compose ps
    echo "--- local health ---"
    curl -s http://127.0.0.1:8080/api/health || echo "(no local response)"
    echo
    if [ "$URL" != "http://127.0.0.1:8080" ]; then
      echo "--- public health ($URL) ---"
      curl -s "$URL/api/health" || echo "(no public response)"
      echo
    fi
    ;;
  logs)     docker compose logs -f --tail=100 ;;
  web)
    echo "▸ rebuilding web bundle"
    docker compose exec imaginator pnpm --filter @imaginator/web build
    echo "▸ done — hard-reload the browser"
    ;;
  restart)  docker compose restart; echo "▸ restarted" ;;
  up)       docker compose up -d; echo "▸ started" ;;
  down)     docker compose down; echo "▸ stopped" ;;
  shell)    docker compose exec imaginator bash ;;
  reinstall)
    docker compose down
    docker volume rm -f imaginator_imaginator_node_modules \
      imaginator_imaginator_nm_core imaginator_imaginator_nm_server \
      imaginator_imaginator_nm_web >/dev/null 2>&1 || true
    docker compose up -d
    echo "▸ reinstalling deps in the background; watch with ./ctl.sh logs"
    ;;
  *) echo "usage: $0 {status|logs|web|restart|up|down|shell|reinstall}" >&2; exit 2 ;;
esac
