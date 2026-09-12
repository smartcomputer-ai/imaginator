#!/usr/bin/env bash
# Boots Imaginator inside the container.
#   - installs deps into the node_modules volumes when missing (first run, or after a wipe)
#   - builds the web bundle when missing
#   - runs the server under tsx watch, so edits to packages/*/src reload instantly
set -euo pipefail
cd /app

if [ ! -x node_modules/.bin/tsx ]; then
  echo "▸ installing dependencies (first run)"
  pnpm install
fi

if [ ! -f packages/web/dist/index.html ]; then
  echo "▸ building web bundle (first run)"
  pnpm --filter @imaginator/web build
fi

echo "▸ starting server (watch mode) on :${IMAGINATOR_PORT:-8080}"
exec pnpm --filter @imaginator/server exec tsx watch src/main.ts
