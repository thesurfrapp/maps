# CLAUDE.md — Surfr maps fork

Local dev notes for the fork hosted at `maps.thesurfr.app`. This project is a
SvelteKit app compiled to static assets (via `@sveltejs/adapter-static`) and
served by Cloudflare Pages, **with a set of Pages Functions under `functions/`
that proxy tile traffic through an R2 cache**. The Functions are the critical
piece — `vite dev` alone doesn't execute them.

## Starting locally

Plain `npm run dev` will load the Svelte app but the page goes **white** as
soon as it tries to fetch `/tiles/latest.json` — Vite doesn't run the Pages
Functions, so those paths 404 and the app can't bootstrap. Always run the
build + Pages Dev path instead.

Helper script — builds the bundle, serves via `wrangler pages dev`, and
optionally exposes it over HTTPS via `cloudflared`:

```sh
./startup.sh              # build + wrangler pages dev + cloudflared tunnel
./startup.sh --no-tunnel  # build + wrangler pages dev only
PORT=9999 ./startup.sh    # override the local port (default 8788)
```

Manual equivalent (for debugging):

```sh
yarn build   # or: npm run build
npx wrangler pages dev build \
  --ip 0.0.0.0 \
  --port 8788 \
  --compatibility-date 2025-01-01
```

Then in a second terminal, to expose the app to a phone over HTTPS:

```sh
cloudflared tunnel --url http://localhost:8788
```

`cloudflared` prints a public `*.trycloudflare.com` URL — paste it into the
device's browser or temporarily swap it into `MAP_URL` in the RN host
(`frontend/components/src/screens/Spots/openMeteoMapConfig.js`) to exercise
the real embed flow.

### Prerequisites

- `node` / `npm` (or `yarn`) — no wrangler install needed; `npx wrangler` pulls it on demand.
- `cloudflared` — `brew install cloudflare/cloudflare/cloudflared`.

## Why not `vite dev`?

The upstream README says `npm run dev` is the dev command, and for the
vanilla open-meteo/maps project that's true — it hits Open-Meteo's public
tile origin directly. **This fork** re-routes all tile traffic through
`/tiles/*` on the same origin so a Pages Function can serve from R2 (see
`v1.md` for the 4-tier cache architecture). With `vite dev`:

- `GET /tiles/latest.json` → 404 (no Pages Function runtime).
- App fails to load domain metadata → white screen.

`wrangler pages dev build` runs both the static assets and the Pages
Functions under `functions/` against a local Miniflare, so the full request
path works exactly like production.

## Architecture quick reference

- `src/` — SvelteKit app. Entry is `src/routes/+page.svelte`.
- `src/lib/components/run-date-label.svelte` — top-center label showing the
  loaded model run plus (debug) the currently-selected time in the embed's
  display timezone. Useful for manually aligning the webview against the RN
  host's bottom-sheet header.
- `src/lib/rn-bridge.ts` — postMessage contract with the React Native host
  (setTime, setDomain, setVariable, setTzOffsetSeconds, etc.).
- `functions/` — Cloudflare Pages Functions. The `tiles/[[path]].ts` catch-all
  serves `.om` + `latest.json` from R2, falls back to upstream, fills R2 via
  `waitUntil`. See `v1.md` §1.1.
- `worker-cron/` — separate Cloudflare Worker that fires the tile warmer on
  a schedule (§1.2 in `v1.md`). Has its own `npm run dev` via `wrangler dev`.
- `wrangler.toml` — Pages project config with the R2 binding.

## Gotchas

- After editing `.svelte` / `.ts` sources, **re-run the build** — Pages Dev
  serves from `build/`, it doesn't watch `src/`. For faster iteration on UI
  only, run `vite dev` in a second terminal and accept the tile 404s (most
  of the UI still renders if you skip the metadata fetch path).
- R2 calls from `wrangler pages dev` hit your real bucket by default. If
  you only want local-only storage, pass `--r2=TILE_CACHE` (the binding
  name) with a local Miniflare R2 — see wrangler docs.
- `.wrangler/` caches auth + state locally; safe to `rm -rf` if wrangler
  starts behaving oddly.
