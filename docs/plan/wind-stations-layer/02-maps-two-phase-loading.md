# [Maps] Wind stations — two-phase loading (skeleton paint + live hydration) in windy-stations.ts

> Jira: [SRF-2644](https://surfrapp.atlassian.net/browse/SRF-2644) · blocked by [SRF-2643](https://surfrapp.atlassian.net/browse/SRF-2643) (backend file generation)
> Architecture doc (NFRs, measured budgets, risk register): https://claude.ai/code/artifact/e78df5bc-d985-4368-a792-15dfa806c9fd

## Goal

Rework `src/lib/windy-stations.ts` so the wind-station layer paints instantly from a
cached static skeleton (positions + pre-baked cluster nodes; zero network on repeat
open) and hydrates live wind values via feature-state from a small readings file on a
5-minute timer. Removes per-pan bbox fetches, the `limit=500` cluster undercount, and
all client-side clustering. Steady-state cost: one ≤20 KB fetch per 5 minutes and a
paint-only repaint — no re-parse, no re-cluster, no symbol re-layout at cluster zooms.

## Decisions already made (do NOT re-litigate)

- **Two-phase data model.** `cache/stations/skeleton.json` (nightly, cached hard,
  generation version `v`) + `cache/stations/readings.json` (5-min, `max-age=300` + SWR),
  served from the main GCS bucket
  (`https://storage.googleapis.com/<bucket>/cache/stations/...`). Produced by
  SRF-2643; formats documented in the backend plan.md
  (`backend/docs/plan/wind-stations-layer/01-backend-skeleton-readings.md`).
- **One rendering switch at z8, spots' shape without spots' data swap.** z0–7 cluster
  nodes (circle layer), z8+ individuals. Both ship in the single skeleton; the boundary
  is layer `minzoom`/`maxzoom` constants. The z11 speed-label appearance is a text
  gate on the same layer, not a switch.
- **No client-side clustering.** `cluster: true`, `clusterProperties`, and the atan2
  cluster-bearing expression are **deleted, not adapted**. Cluster nodes are ordinary
  point features. Drill-down = `easeTo` to the node's baked `expansionZoom` (no
  `getClusterExpansionZoom` async round-trip).
- **Clusters are color-only** (max wind via `setFeatureState`) — no numbers, no arrows
  on bubbles. feature-state drives paint properties only; numbers/arrows appear on
  individuals at z8+.
- **Skeleton is URL-fed** to the GeoJSON source so MapLibre parses it in its worker —
  zero main-thread JSON work on the critical path.
- **Live merge:** readings → id-keyed hashmap → `setFeatureState` for node/dot colors;
  pills/arrows/labels at z8+ refresh via one small `setData` per cycle. **Absence from
  the hashmap (or `obsTs` > 60 min) renders dimmed** — no staleness field exists.
- **Refresh loop:** every 5 min while the layer is visible AND the webview is
  foregrounded; paused otherwise; ETag/If-None-Match for free 304s.
- **Version guard:** readings `v` ≠ skeleton `v` → refetch skeleton (usually a 304).
- **`MIN_ZOOM = 5` removed** — stations visible at every zoom; node circle radius
  interpolates down with zoom so world view reads as a density texture.
- **bbox endpoint leaves the map path.** `/windystations/bbox` remains only for
  search, tap details (names live there — the skeleton has none), and legacy app
  versions.
- **Module API surface unchanged:** `initWindyStations`, `setWindyStationsConfig`,
  `setWindyStationsVisible`, `teardownWindyStations`; rn-bridge contract untouched
  (config gains the station-files base URL).
- **Bug fix in scope:** stations with `windKts` but `windDir == null` must not render
  an arrow (current `?? 0` at windy-stations.ts:588 fabricates a due-north direction).

## Open questions

- None blocking. Node-grid visual density (z8 vs z9) is validated in the device test
  and tuned server-side; the client only reads zoom constants.

## Context (read first)

- Current implementation: `src/lib/windy-stations.ts` (801 lines) — clustered GeoJSON
  source + 4 symbol layers (selection halo, pill, verified badge, arrow), debounced
  bbox fetch. `promoteId` + feature-state already used for selection — extend the same
  mechanism for live values.
- Keep: pill/arrow/badge visual design, canvas image atlas, selection handling,
  interaction handlers, `rn-bridge.ts` message contract.
- Dev loop: `./startup.sh` (wrangler pages dev — plain `vite dev` white-screens on the
  tiles path, see CLAUDE.md); `cloudflared` tunnel for on-device testing.
- Perf budgets to hit (architecture doc §04): repeat-open paint < 200 ms after style
  load; hydration ≤ 1.5 s; zero station fetches on pan/zoom; ≥ 50 fps pan on
  iPhone-8-class hardware.

## Files to create / modify

- `src/lib/windy-stations.ts` — main rework: source setup (URL-fed skeleton), node +
  individual layers with the z8 switch, readings hashmap + feature-state hydration,
  refresh timer with visibility pause, version guard, drill-down, arrow-direction fix
- `src/lib/rn-bridge.ts` — pass station-files base URL through
  `setWindyStationsConfig` (shape-compatible; no host app change required)
- New helper module (or section) for the readings fetch/merge/version-guard logic

## Acceptance criteria

- [ ] Repeat map open paints nodes/stations with zero station-related network
      requests (HTTP cache); cold open needs exactly two (skeleton + readings)
- [ ] No station fetch fires on pan or zoom at any zoom level
- [ ] Live colors update within one refresh cycle without visible flicker or symbol
      re-placement at z0–7
- [ ] Stations absent from readings render dimmed; `windDir`-less stations show no arrow
- [ ] Cluster drill-down eases to the node's baked `expansionZoom`
- [ ] Timer pauses when the layer is hidden or the webview backgrounded (verify via
      network log)
- [ ] Device test on the oldest office phone: pan/zoom at z6–9 over NL/BE stays fluid
      (≥ 50 fps target) — gate from architecture doc §04
- [ ] `cluster: true` / supercluster / atan2-expression code paths removed

## Out of scope

- `delta.json` consumption (V2, ships with the all-stations mode)
- Inactive-stations filter UI and the all-variant skeleton
- Any RN host app changes

## Confidence: 80%

Riskiest unknown: symbol re-placement cost of the z8+ `setData` refresh on old GPUs —
if the device test shows hitches, fall back to feature-state-only dot colors at z8–9
and gate pills to z10+.
