# Surfr Maps

**[maps.thesurfr.app](https://maps.thesurfr.app)**

A fork of [open-meteo/maps](https://github.com/open-meteo/maps) that adds a Cloudflare R2 tile-caching layer, a React Native embed bridge, a simplified surf/wind-focused UI, and a custom Surfr wind color palette. Deployed on Cloudflare Pages.

## Why this fork exists

The upstream open-meteo/maps project is a standalone browser demo that fetches `.om` weather tiles directly from Open-Meteo's S3 origin. Surfr embeds these maps inside a React Native app where we need:

- **Low-latency tile delivery** — a 4-tier Cloudflare cache (browser → CF edge → R2 → origin) with a 5-minute cron warmer so tiles are hot before users request them.
- **Immutable tile URLs** — each model run gets a unique URL path (`/YYYY/MM/DD/HHmmZ/…`), enabling aggressive `Cache-Control: immutable` and reliable `Range` request caching.
- **A postMessage bridge** — bidirectional communication with the React Native WebView host (`setTime`, `setDomain`, `setVariable`, `setCenter`, `setSpotsConfig`, etc.).
- **A stripped-down UI** — wind/gust/rain pill selectors, a 13-model dropdown, an IANA timezone picker, and optional surf-spot markers instead of the full upstream chrome.
- **Surfr's wind color scale** — a high-saturation palette matching Windguru-style anchors, force-applied to all wind/gust variables.

## What's changed from upstream

This fork is **~90 commits / +7,100 lines** ahead of upstream (`open-meteo/maps@f076847`).

### Tile caching & CDN (the big one)

All `.om` and `latest.json` traffic routes through `maps.thesurfr.app/tiles/*` instead of hitting Open-Meteo's origin directly.

| Component | Path | What it does |
|---|---|---|
| Pages Function proxy | `functions/tiles/[[path]].ts` | Serves `.om` from R2, falls back to origin + lazy R2 fill. Serves `latest.json` from R2 with `no-store`. Blocks `meta.json`/`in-progress.json`. |
| Warmer pipeline | `functions/lib/warmer.ts` | Fetches upstream `latest.json`, diffs against R2, warms `.om` files (concurrency 4, 72 h horizon cap), atomically swaps `latest.json`, prunes old runs (keeps current + 2). |
| Admin dashboard | `functions/tiles/_admin.ts` | Per-domain status pills, R2 vs upstream comparison, file counts, historical runs. |
| Cron worker | `worker-cron/` | Fires the warmer every 5 min, one domain at a time, with 1.5 s pauses. |
| ADR | `docs/adr/0001-caching-architecture.md` | Full design doc: 4-tier diagram, TTL table, invariants, PoP strategy, cost model. |

### React Native embed bridge

`src/lib/rn-bridge.ts` — active when `?embed=1`. Sends `ready`, `moveend`, `availableTimestamps`, `timestampChanged`, `mapIdle`, etc. Receives `setCenter`, `setTime`, `setDomain`, `setVariable`, `setTzOffsetSeconds`, `setSpotsConfig`. All messages carry `performance.now()` timestamps for host-side diagnostics.

### Simplified UI

The upstream variable picker, dark/help/settings/clipping/hillshade buttons are replaced with:

- **OverlayPills** — wind / gusts / rain toggle (auto-handles GFS domain swapping)
- **ModelPills** — 13-model dropdown (MET Nordic → GFS)
- **TimezoneSelector** — IANA dropdown with live UTC offsets, DST-aware
- No model-run picker — always shows the latest run from R2

### Surfr wind color scale

`src/lib/color-scales/surfr.ts` — blue → cyan → green → lime → yellow → orange → red → pink → magenta → purple at 1-kt resolution. Alpha floor 0.35 for dark basemap readability. Force-applied via a resolver override in `om-protocol-settings.ts`.

### Basemap & styling

OpenFreeMap (positron/dark) replaces the upstream basemap. Heavy style filtering: transportation, buildings, landcover hidden; white country borders (no maritime); dedicated coastline layer; reduced arrow density and opacity.

### Surfr spots layer

`src/lib/surfr-spots.ts` — optional cyan dot + label markers for the user's saved spots above zoom 8. Fetched from a configurable API endpoint with bearer token, debounced on map move.

### Display timezone rework

Full IANA timezone support with `toShifted`/`fromShifted` helpers, DST-aware offset calculation, and RN bridge override. Replaces upstream's browser-local-only timezone handling.

## Diff summary

| Concern | Upstream | This fork |
|---|---|---|
| Tile origin | Open-Meteo S3 direct | CF Pages proxy → R2 → origin, 5-min cron warmer |
| URL shape | `meta.json`-derived, can drift | `latest.json`-derived, immutable per run |
| `.om` caching | Browser heuristic | `max-age=2592000, immutable` |
| `latest.json` caching | Browser heuristic | `no-store` (always fresh from R2) |
| Basemap | `map-assets.open-meteo.com` | OpenFreeMap + heavy style filter |
| UI | Full variable picker + settings | Wind/gust/rain pills + model dropdown |
| Timezone | Browser local or UTC | IANA dropdown + RN override |
| Model-run picker | User selects any run | Removed — always latest |
| Wind colors | Library default | Surfr palette |
| Embed | None | Full RN postMessage bridge |
| Spots | None | Optional cyan markers above zoom 8 |
| SSR | Enabled | Disabled (`ssr = false`) |

## Development

> **`npm run dev` will show a white screen** — Vite doesn't run the Pages Functions, so `/tiles/latest.json` 404s. Always use the build + Pages Dev path.

```bash
npm install

# Recommended: build + wrangler pages dev + optional cloudflared tunnel
./startup.sh              # full stack
./startup.sh --no-tunnel  # skip cloudflared

# Manual equivalent
npm run build
npx wrangler pages dev build --ip 0.0.0.0 --port 8788 --compatibility-date 2025-01-01
```

To test on a phone over HTTPS (requires `cloudflared`):

```bash
cloudflared tunnel --url http://localhost:8788
```

### Prerequisites

- Node.js / npm (or yarn)
- `cloudflared` — `brew install cloudflare/cloudflare/cloudflared` (optional, for phone testing)
- No global wrangler install needed — `npx wrangler` pulls it on demand

## Architecture

```
Browser / RN WebView
  │
  ├─ static assets ──→ Cloudflare Pages (build/)
  │
  └─ /tiles/* ────────→ Pages Function
                          ├─ CF edge cache (auto)
                          ├─ R2 bucket (surfr-tile-cache)
                          └─ Open-Meteo S3 origin (fallback + lazy fill)

worker-cron (*/5 * * * *)
  └─ hits /tiles/_warmer-trigger per domain
     └─ warms R2 from upstream, swaps latest.json atomically
```

## Upstream

Forked from [open-meteo/maps](https://github.com/open-meteo/maps) — a MapLibre GL weather map UI powered by [Open-Meteo OMfiles](https://github.com/open-meteo/weather-map-layer).
