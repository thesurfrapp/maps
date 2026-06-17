# Surfr Maps

> **This is a public repository.** Do not commit API keys, tokens, `.env` files, or other secrets. Use environment variables and Cloudflare secret bindings for all credentials.

**[maps.thesurfr.app](https://maps.thesurfr.app)**

A fork of [open-meteo/maps](https://github.com/open-meteo/maps) that adds a Cloudflare R2 tile-caching layer, a React Native embed bridge, live wind-station and surf-spot overlays, a simplified surf/wind-focused UI, and a custom Surfr wind color palette. Deployed on Cloudflare Pages.

## Why this fork exists

The upstream open-meteo/maps project is a standalone browser demo that fetches `.om` weather tiles directly from Open-Meteo's S3 origin. Surfr embeds these maps inside a React Native app where we need:

- **Low-latency tile delivery** — a 4-tier Cloudflare cache (browser → CF edge → R2 → origin) with a 5-minute cron warmer so tiles are hot before users request them.
- **Immutable tile URLs** — each model run gets a unique URL path (`/YYYY/MM/DD/HHmmZ/…`), enabling aggressive `Cache-Control: immutable` and reliable `Range` request caching.
- **A postMessage bridge** — bidirectional communication with the React Native WebView host for map state, forecast location, spot selection, wind stations, and tile-fetch diagnostics.
- **Live wind stations** — Windy-style colored pill markers showing real-time wind speed/direction from the Surfr backend's `/windystations/bbox` endpoint, tappable to open a station detail sheet in the RN host.
- **Surfr spots on the map** — the user's saved surf/kite spots rendered as cyan dots + labels, tappable to set a forecast location and trigger a "View details" pill in the RN host.
- **A stripped-down UI** — wind/gust/rain pill selectors, a 13-model dropdown, an IANA timezone picker instead of the full upstream chrome.
- **Surfr's wind color scale** — a high-saturation palette matching Windguru-style anchors, force-applied to all wind/gust variables.

## What's changed from upstream

This fork is **~90 commits / +7,100 lines** ahead of upstream (`open-meteo/maps@f076847`).

### Tile caching & CDN

All `.om` and `latest.json` traffic routes through `maps.thesurfr.app/tiles/*` instead of hitting Open-Meteo's origin directly.

| Component | Path | What it does |
|---|---|---|
| Pages Function proxy | `functions/tiles/[[path]].ts` | Serves `.om` from R2, falls back to origin + lazy R2 fill. Serves `latest.json` from R2 with `no-store`. Blocks `meta.json`/`in-progress.json`. |
| Warmer pipeline | `functions/lib/warmer.ts` | Fetches upstream `latest.json`, diffs against R2, warms `.om` files (concurrency 4, 72 h horizon cap), atomically swaps `latest.json`, prunes old runs (keeps current + 2). |
| Admin dashboard | `functions/tiles/_admin.ts` | Per-domain status pills, R2 vs upstream comparison, file counts, historical runs. |
| Cron worker | `worker-cron/` | Fires the warmer every 5 min, one domain at a time, with 1.5 s pauses. |
| ADR | `docs/adr/0001-caching-architecture.md` | Full design doc: 4-tier diagram, TTL table, invariants, PoP strategy, cost model. |

### React Native embed integration

The map is embedded in the Surfr RN app as a full-screen `react-native-webview` WebView (`frontend/components/src/screens/Spots/components/OpenMeteoMapView.js`). The initial URL carries state as query params (`?embed=1&domain=X&variable=Y&time=Z&theme=dark&tz_offset_seconds=N&spots_endpoint=…&spots_token=…#zoom/lat/lng`). All subsequent state changes flow via `postMessage` — no page reloads.

**RN → WebView (inbound commands):**

| Message | Purpose |
|---|---|
| `setCenter` | Fly to lat/lng/zoom with optional `anchorY` offset (used when the bottom sheet covers the lower viewport) |
| `setTime` | Set the active forecast hour (snapped to nearest valid_time) |
| `setDomain` / `setVariable` | Switch weather model / overlay variable |
| `setTzOffsetSeconds` | Override display timezone (spot's UTC offset) |
| `setSpotsConfig` | Supply or refresh the spots API endpoint + bearer token |
| `setWindyStationsConfig` | Supply the wind stations API endpoint + toggle visibility |
| `setForecastLocation` | Drop the red forecast pin without moving the camera |
| `setSpotHighlight` / `clearSpotSelection` | Show/hide the blue pulsing ring around a selected spot |
| `setZoom` | Fly to zoom level with auto globe/mercator projection flip |
| `clearState` | Wipe Cache Storage + localStorage and reload (stuck-state escape hatch) |

**WebView → RN (outbound events):**

| Message | Purpose |
|---|---|
| `ready` | Map loaded, bridge accepting commands |
| `moveend` | Camera moved — lat/lng/zoom |
| `forecastLocationSet` | User tapped empty map — lat/lng for the forecast table |
| `spotSelected` | User tapped a Surfr spot — id/name/lat/lng, triggers "View details" pill in RN |
| `stationTapped` | User tapped a wind station pill — id/name/lat/lon/windKts/windDir/gustKts/updatedAt |
| `availableTimestamps` | Model's valid_times manifest (RN drives its time scrubber from this) |
| `availableVariables` | Model's variable list (RN disables unsupported overlay pills) |
| `timestampChanged` | Fork picked/snapped a time — authoritative for cold start |
| `referenceTime` | Which model run is loaded (diagnostic) |
| `tileFetch` | Per-tile fetch report: URL, status, ms, bytes, cache status, Range header (diagnostic) |
| `mapDataLoading` / `mapIdle` | Render lifecycle markers for scrub-to-paint wall-time measurement |
| `storageEstimate` | Cache API quota/usage probe (diagnostic) |

The RN wrapper (`OpenMeteoMapView.js`) exposes imperative methods via ref (`setCenter`, `centerForSheet`, `setZoom`, `setMarker`, `setTime`, `setSpotHighlight`, `clearSpotSelection`, `resetState`) and queues messages until the fork reports `ready`. Config lives in `openMeteoMapConfig.js` which maps overlay names to variable aliases and model keys to tile domains (including per-overlay domain overrides like GFS wind vs gust).

All outbound messages carry `t = performance.now()` so the RN host can reconstruct a diagnostic timeline (setup time, network time, paint time).

### Live wind stations

`src/lib/windy-stations.ts` — Windy-style colored pill markers rendered as MapLibre DOM `Marker`s showing real-time wind speed, direction arrow, and gust data. Data fetched from the Surfr backend's `/windystations/bbox` endpoint, debounced 700 ms on map move, visible above zoom 5, limit 200 per viewport. Each pill is colored using Surfr's wind-speed palette and is tappable — taps emit `stationTapped` to the RN bridge, which opens a `WindyStationSheet` with the station's history chart. Stale stations render as grey pills at reduced opacity. Verified (non-PWS) stations show a green checkmark badge.

Configured via the RN bridge's `setWindyStationsConfig` message (endpoint URL + visibility toggle). The endpoint is the same Surfr backend used for spots.

### Surfr spots layer

`src/lib/surfr-spots.ts` — the user's saved surf/kite spots rendered as cyan circles (`circle-radius: 4`) + white text labels via a GeoJSON source, visible above zoom 8. Fetched from the Surfr backend's `/spots/bbox` endpoint with bearer token auth, debounced 500 ms on map move, limit 100 per viewport. Tapping a spot (with ±16 px hit padding for fat-finger tolerance) snaps the forecast location to the spot's exact coordinates, emits `spotSelected` + `forecastLocationSet` to RN, and lights up a CSS-animated blue pulsing ring around the dot. Tapping empty map clears the ring.

Configured via URL params (`spots_endpoint`, `spots_token`) on initial load and refreshable via the bridge's `setSpotsConfig` message.

### Client-side neighbor prefetch (PoP warm)

`src/lib/pop-warm.ts` — on every time/domain/variable change, prefetches adjacent timesteps in two tiers:
- **±1 neighbors** — full prefetch via `WeatherMapLayerFileReader.prefetchVariable`, pulling all blocks into the shared browser block cache so prev/next scrub renders instantly from local cache.
- **±2..±N outer neighbors** — `Range: bytes=0-0` HEAD probes that nudge CF's PoP edge cache without pulling data into the browser. If the user scrubs to these, the round-trip is local edge (~50 ms) instead of R2 (~300–500 ms).

Skip-already-warmed sets prevent redundant fetches during rapid scrubbing.

### Simplified UI & always-latest-run UX

Upstream lets users manually pick a model run (dropdown + lock button + prev/next-run keyboard shortcuts). This fork removes all of that — the map always shows the latest available run as determined by R2's `latest.json`. The cron warmer atomically swaps `latest.json` when a new run completes, and the client fetches it fresh on every page load (`Cache-Control: no-store`). Users never see a stale run, never have to understand what a "model run" is, and can't accidentally lock themselves to an old one. The `RunDateLabel` component shows which run is loaded for debugging, but there's no UI to change it.

The upstream variable picker, dark/help/settings/clipping/hillshade buttons are also replaced with:

- **OverlayPills** (`src/lib/components/overlay-pills/overlay-pills.svelte`) — wind / gusts / rain toggle. Maps each overlay to alias variable names, picks the first present in the model's manifest. Special-cases GFS domain pair (`ncep_gfs013` for wind/rain, `ncep_gfs025` for gusts).
- **ModelPills** (`src/lib/components/overlay-pills/model-pills.svelte`) — 13-model dropdown (MET Nordic, Arome-HD, ICON-D2, KNMI NL/EU, UKV, Arome, GEM HRDPS, HRRR, ICON-EU, ECMWF, ICON, GFS). Auto-flips GFS domain when switching between wind and gust overlays.
- **TimezoneSelector** (`src/lib/components/timezone/TimezoneSelector.svelte`) — IANA timezone dropdown using `Intl.supportedValuesOf('timeZone')`, labels include live UTC offset (DST-aware), persisted to localStorage.
- **RunDateLabel** (`src/lib/components/run-date-label.svelte`) — top-center label showing the loaded model run (debug/informational only).

### Surfr wind color scale

`src/lib/color-scales/surfr.ts` — blue → cyan → green → lime → yellow → orange → red → pink → magenta → purple at 1-kt resolution. Alpha floor 0.35 for dark basemap readability. Force-applied to all `wind_speed_*`, `wind_gusts_*`, and `wind_u/v_component_*` variables via a hard resolver override in `src/lib/stores/om-protocol-settings.ts`.

### Basemap & styling

MapTiler Streets v2 (`streets-v2-dark` / `voyager-v2`) is the primary basemap, configured via `VITE_MAPTILER_KEY` env var. Falls back to OpenFreeMap (`positron` / `dark`) when the key is absent so dev works without credentials. The OpenFreeMap fallback gets aggressive style filtering (transportation, buildings, landcover, landuse, waterway, aeroway, park layers hidden; sub-national admin + micro-place labels hidden; white country borders excluding maritime; dedicated `surfr_coastline` layer tracing ocean polygons). MapTiler is left mostly intact — only English-label override is applied. Arrow density reduced (widths 0.7–1.3, alpha 0.15–0.4 vs upstream's 1.5–2.8, 0.2–0.7). Wheel/touch zoom rate set to `1/85`.

### Display timezone rework

`src/lib/time-format.ts` — full IANA timezone support: `toShifted`/`fromShifted` helpers that shift UTC dates by offset so UTC getters read target-TZ values; `getIanaOffsetSeconds(tz, at)` for DST-aware offset calculation via `Intl.DateTimeFormat.formatToParts`; display-day/time/date formatters. `src/lib/stores/preferences.ts` adds `displayTimezone` (persisted IANA string) and `displayTzOffsetSeconds` (writable, set by RN bridge or derived from IANA name). The time selector uses display-tz equivalents throughout.

### Domain load serialization

`+page.svelte` serializes domain-switch work with a chain + sequence IDs. Without this, Svelte fires the domain subscription multiple times during startup (initial value + URL params + RN bridge `setDomain`), async callbacks race, shared stores mutate out of order, and `modelRun` ends up `undefined` — causing ~50% of cold starts to get stuck. Includes retry with exponential backoff (500 ms / 1 s / 2 s) for transient edge 5xx during model-run publishes.

### Forked weather-map-layer dependency

`package.json` pins `@openmeteo/weather-map-layer` to `github:thesurfrapp/weather-map-layer#5970398…` — a Surfr fork that adds parallel prefetch support (used by `pop-warm.ts`). Default cache block size bumped from 64 KB to 512 KB (3× fewer range requests per viewport render).

## Diff summary

| Concern | Upstream | This fork |
|---|---|---|
| Tile origin | Open-Meteo S3 direct | CF Pages proxy → R2 → origin, 5-min cron warmer |
| URL shape | `meta.json`-derived, can drift | `latest.json`-derived, immutable per run |
| `.om` caching | Browser heuristic | `max-age=2592000, immutable` |
| `latest.json` caching | Browser heuristic | `no-store` (always fresh from R2) |
| Basemap | `map-assets.open-meteo.com` | MapTiler Streets v2 (`VITE_MAPTILER_KEY`), OpenFreeMap fallback |
| UI | Full variable picker + settings | Wind/gust/rain pills + model dropdown + tz selector |
| Timezone | Browser local or UTC | IANA dropdown + RN bridge override, DST-aware |
| Model-run picker | Dropdown + lock + prev/next shortcuts | Removed — always latest run via R2 `latest.json`, no user choice |
| Wind colors | Library default | Surfr high-saturation palette |
| Embed | None | Full RN WebView postMessage bridge + imperative ref API |
| Wind stations | None | Live Windy-style pills from Surfr backend `/windystations/bbox` |
| Spots | None | Cyan dot markers from Surfr backend `/spots/bbox`, tappable |
| Prefetch | None | ±1 full prefetch + ±N PoP edge warm on every time change |
| Domain load | Single async, can race | Serialized chain + retry with backoff |
| weather-map-layer | npm upstream | Surfr fork with parallel prefetch, 512 KB block size |
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

### Local `weather-map-layer` development

`package.json` pins `@openmeteo/weather-map-layer` to a commit on the Surfr fork (`github:thesurfrapp/weather-map-layer#<sha>`). The source lives locally at `../weather-map-layer`. To iterate on the library and test changes in this maps project:

```bash
# In the weather-map-layer repo
cd ../weather-map-layer
npm run build          # produces dist/

# Link it into this project
cd ../maps
npm link ../weather-map-layer
```

After linking, any rebuild of `weather-map-layer` is immediately available to the maps build (no reinstall needed). When done, commit the new dist to the fork, push, and update the pinned SHA in `package.json`:

```bash
# Update the pin to the new commit
npm install github:thesurfrapp/weather-map-layer#<new-sha>
```

`npm install` (without a link) will restore the pinned GitHub commit and remove the local link.

### Prerequisites

- Node.js / npm (or yarn)
- `cloudflared` — `brew install cloudflare/cloudflare/cloudflared` (optional, for phone testing)
- No global wrangler install needed — `npx wrangler` pulls it on demand

## Architecture

```
RN App (SpotsScreen)
  │
  └─ OpenMeteoMapView (WebView)
       │  ↕ postMessage bridge (rn-bridge.ts ↔ OpenMeteoMapView.js)
       │
       ├─ static assets ──→ Cloudflare Pages (build/)
       │
       ├─ /tiles/* ────────→ Pages Function
       │                       ├─ CF edge cache (auto)
       │                       ├─ R2 bucket (surfr-tile-cache)
       │                       └─ Open-Meteo S3 origin (fallback + lazy fill)
       │
       ├─ /spots/bbox ─────→ Surfr backend (user's saved spots)
       │
       └─ /windystations/bbox → Surfr backend (live wind station data)

worker-cron (*/5 * * * *)
  └─ hits /tiles/_warmer-trigger per domain
     └─ warms R2 from upstream, swaps latest.json atomically
```

## Upstream

Forked from [open-meteo/maps](https://github.com/open-meteo/maps) — a MapLibre GL weather map UI powered by [Open-Meteo OMfiles](https://github.com/open-meteo/weather-map-layer).
