#!/usr/bin/env bash
#
# Local dev for the Surfr maps fork: builds, serves via Cloudflare Pages (so
# the Pages Functions under `functions/` actually run — `vite dev` does NOT
# execute them, which is why a plain `npm run dev` gives a white screen), and
# exposes the result through a Cloudflare quick tunnel so a phone / RN app
# can hit it over HTTPS.
#
# Usage:
#   ./startup.sh            # build + serve + tunnel
#   ./startup.sh --no-tunnel # build + serve only
#   PORT=9999 ./startup.sh  # override local port (default 8788)
#
# Requires:
#   - node / npm (or yarn)
#   - `cloudflared` in PATH   (brew install cloudflare/cloudflare/cloudflared)
#   - `npx wrangler`          (auto-downloaded by npx if missing)
#
set -euo pipefail

PORT="${PORT:-8788}"
TUNNEL=1
if [[ "${1:-}" == "--no-tunnel" ]]; then TUNNEL=0; fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "==> Building static bundle (vite build, adapter-static -> ./build)"
if command -v yarn >/dev/null 2>&1 && [ -f yarn.lock ]; then
  yarn build
else
  npm run build
fi

echo "==> Starting wrangler pages dev on :$PORT"
npx wrangler pages dev build \
  --ip 0.0.0.0 \
  --port "$PORT" \
  --compatibility-date 2025-01-01 &
WRANGLER_PID=$!

# Ensure we clean up the background process(es) on Ctrl-C / exit.
cleanup() {
  echo
  echo "==> Shutting down (pid=$WRANGLER_PID ${TUNNEL_PID:+/ tunnel=$TUNNEL_PID})"
  kill "$WRANGLER_PID" 2>/dev/null || true
  [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Give wrangler a moment to open its listener before the tunnel attaches.
sleep 2

if [[ "$TUNNEL" == "1" ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "!! cloudflared not found in PATH — skipping tunnel."
    echo "   Install: brew install cloudflare/cloudflare/cloudflared"
    wait "$WRANGLER_PID"
    exit $?
  fi
  echo "==> Starting cloudflared quick tunnel -> http://localhost:$PORT"
  # `cloudflared tunnel --url` spawns a free trycloudflare.com URL we can
  # hit from the phone. Its public URL is printed to stdout on start-up.
  cloudflared tunnel --url "http://localhost:$PORT" &
  TUNNEL_PID=$!
fi

# Block on wrangler so the script stays alive until someone Ctrl-Cs it.
wait "$WRANGLER_PID"
