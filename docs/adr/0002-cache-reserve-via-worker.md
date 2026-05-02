# ADR 0002 — Move tile-serving to standalone Worker, unblock Cache Reserve

- **Status**: Accepted
- **Date**: 2026-05-02
- **Supersedes**: serving paths in ADR 0001 (Pages Function `[[path]].ts`'s
  `.om` + `latest.json` branches). The R2 bucket, cron warmer, run-path URL
  scheme, and admin endpoints carry over unchanged.
- **Scope**: `worker-tiles/`, `worker-rewarmer/`, `worker-cron/`,
  `functions/tiles/[[path]].ts` (now backwards-compat only), DNS records for
  `tiles.thesurfr.app`, CF Cache Rules.

## Context

ADR 0001's tiered design left **cross-PoP first hits** as the weak link:
without Cache Reserve, the only thing between R2 and the user was per-PoP
edge cache. A user landing on a fresh PoP after a run swap paid one R2
round-trip — measured at 1.5–6 s for the 168 MB ICON-Global files.

Cache Reserve was meant to fill that gap: a global, persistent CF cache
tier that any PoP can read from. We enabled it on the zone, configured a
Cache Rule with eligibility, and pre-warmed via a companion worker.
Result: `Egress bytes saved` stayed at 0 B for months. Every cross-PoP
request was `cf-cache-status: MISS`.

CF support diagnosed the cause:

> Cache Reserve is bypassed for all O2O traffic. Adding a custom domain to a
> Cloudflare Pages project routes traffic through pages.dev (a separate
> Cloudflare zone), and CR is documented as bypassed for that path.

The fix: move tile-serving off Pages Functions onto a standalone Worker
on its own custom domain. Workers on a Custom Domain run directly on the
zone — no Orange-to-Orange hop, CR engages.

A second issue surfaced during deployment: **Cache Rules alone don't
reliably trigger cache-layer engagement for Worker responses**. With the
new Worker on `tiles.thesurfr.app` and a correctly-configured rule
(`Eligible for cache`, `Eligible for Cache Reserve`, `≥1 MB`), CF still
returned no `cf-cache-status` header at all — the cache layer wasn't
engaged. The Worker has to call `caches.default.put()` itself; the rule
applies on the put, not on the response stream.

## Decision

### Topology

```
maps.thesurfr.app  ──► Pages           SvelteKit frontend
                                       _warmer-trigger     (cron HTTP entry)
                                       _admin              (dashboard)
                                       _debug/cache        (JSON inventory)
                                       /tiles/*            (legacy, backwards
                                                            compat for ~5 d)

tiles.thesurfr.app ──► worker-tiles    .om Range serving
                                       latest.json
                                       Explicit caches.default.put

(service binding REWARMER)
worker-cron ─[*/5 cron]──► Pages /_warmer-trigger    R2 fill
            │                          waitUntil (rewarm)
            └─── service ──► worker-rewarmer         CR populate
                             1 URL / invocation
                             fetch(url, cf.cacheEverything) + drain
```

Four runtimes, each with one job:

| Runtime | Where | Trigger | Job |
|---|---|---|---|
| Pages frontend | `maps.thesurfr.app` (Pages) | HTTP | SvelteKit UI |
| Pages Function | `maps.thesurfr.app/tiles/*` (Pages) | HTTP | Admin (`_warmer-trigger`, `_admin`, `_debug`) + legacy tile serve |
| `worker-cron` | CF Worker | `*/5 * * * *` cron + HTTP `/force` | Per-domain warm dispatch + rewarm dispatch |
| `worker-rewarmer` | CF Worker | service binding from cron | One URL, full fetch, body drain (CR populate) |
| `worker-tiles` | CF Worker on `tiles.thesurfr.app` (custom domain) | HTTP | R2-backed `.om` + `latest.json` serving with Cache API write-through |

### Five-tier cache stack

Two new tiers added on top of ADR 0001's stack:

| Tier | Where | TTL | Populated by |
|---|---|---|---|
| T1 | Browser | `.om`: 30 d + `immutable`. `latest.json`: `no-store`. | Any `.om` HIT response |
| T2a | CF edge cache, per-PoP | 30 d (Cache Rule) | `caches.default.put` from `worker-tiles` on full-object miss |
| **T2b** | **Cache Reserve, global** | **30 d (Cache Rule eligibility)** | **`worker-rewarmer` fires `cf.cacheEverything` GETs after each warmed run** |
| T3 | R2 `surfr-tile-cache` | Current run + 2 prior; older pruned per warm swap | Cron warmer (proactive 72/120 h horizon) + Pages Function `waitUntil(warmR2)` lazy fill |
| T4 | Open-Meteo origin | n/a | — |

T2a serves repeat hits at the same PoP; T2b serves first hits at any new PoP.
Both tiers store the full object — Range requests are sliced on serve.

### Custom-domain choice

`tiles.thesurfr.app` is a **subdomain**, not the same hostname as Pages.
Workers and Pages can't both have a Custom Domain on the same hostname.
DNS + cert auto-provisioned by `wrangler deploy` via the
`[[routes]] custom_domain = true` entry in `worker-tiles/wrangler.toml`.

Alternative considered: Workers Routes pattern (`maps.thesurfr.app/tiles/*`)
sitting alongside Pages. CF support didn't validate that path for CR; we
took the documented "Custom Domain" path.

### URL shape

```
GET https://tiles.thesurfr.app/data_spatial/<domain>/YYYY/MM/DD/HHmmZ/<validTime>.om
GET https://tiles.thesurfr.app/data_spatial/<domain>/latest.json
```

Drops the `/tiles/` prefix from ADR 0001. `worker-tiles` reads
`url.pathname` directly to derive R2 keys (no rewriting).

Frontend constants:
- `src/lib/helpers.ts:getBaseUri()` → `'https://tiles.thesurfr.app'`
- `src/lib/pop-warm.ts:META_BASE` → `'https://tiles.thesurfr.app/data_spatial'`

The legacy Pages Function path (`maps.thesurfr.app/tiles/...`) is left
alive for ~5 days after migration so any cached webview / external client
in flight keeps working. `functions/tiles/[[path]].ts` still serves it
(without CR benefit). To be removed in a follow-up.

### worker-tiles request flow

```
fetch handler
  │
  ├─ method ≠ GET/HEAD → 405
  │
  ├─ url.pathname endsWith /latest.json
  │     └─ R2.get → 200, no-store, never origin
  │
  ├─ url.pathname endsWith .om
  │     │
  │     ├─ TIER 1: caches.default.match(rangeStrippedKey)
  │     │     └─ HIT → sliceCachedFull(cached, range) → 206 / 200, HIT-EDGE
  │     │
  │     ├─ TIER 2 — Range request
  │     │     └─ R2.get(key, range)
  │     │           └─ HIT → r2ToResponse → 206, HIT-R2
  │     │              (no cache write — partials can't seed CR)
  │     │
  │     ├─ TIER 2 — non-Range request
  │     │     └─ R2.get(key)
  │     │           └─ HIT → tee body
  │     │              → ctx.waitUntil(caches.default.put(key, full))
  │     │              → return full to client, HIT-R2
  │     │
  │     └─ TIER 3: fetch(upstream, cf.cacheEverything=true)
  │           └─ ctx.waitUntil(warmR2)
```

Cache key is range-stripped (URL only) so all Range variants share one
entry. The Worker slices the cached full body on serve via
`sliceCachedFull` — reads body into a `Uint8Array`, takes a subarray for
the requested range, returns 206 with a synthesised `Content-Range`.
Memory-bound by file size; .om files cap at ~170 MB which fits inside
the 128 MB-ish Worker memory limit because the Cache API streams.

### Why Range requests on cache miss don't write through

Cache Reserve only stores full 200 responses; 206 partials can't seed it.
If the very first hit at a fresh PoP is a Range request (which it
typically isn't — the rewarmer fires non-Range fetches after each
warmed run), the Worker serves the partial from R2 and skips the cache
write. The next non-Range hit (or the next rewarm cycle) populates the
cache.

The cron rewarmer guarantees this isn't a hot path: every freshly-warmed
run gets a non-Range full fetch per file, so Tier 1 is populated before
any user touches the new run.

### Server-side R2 warm (unchanged from ADR 0001)

Cron at `*/5 * * * *` triggers per-domain calls to
`maps.thesurfr.app/tiles/_warmer-trigger?domain=X&wait=1`. The Pages
Function `warmer.ts`:

1. Fetches upstream `latest.json`.
2. If `reference_time` matches R2's, returns `{status: 'unchanged'}`.
3. Otherwise: fetches `meta.json`, filters `valid_times` by horizon
   (72 h default, 120 h for global models — `EXTENDED_HORIZON_DOMAINS` =
   `{ncep_gfs013, ncep_gfs025, ecmwf_ifs025, dwd_icon, dwd_icon_d2}`).
4. Stream-copies each `.om` from upstream into R2 at concurrency 4.
5. Atomic swap: writes new `latest.json` last, only after all `.om` are
   in R2.
6. Prunes old run paths beyond `current + 2 historical`.

R2 region: ENAM. R2 bucket: `surfr-tile-cache`. Same as ADR 0001.

### Cache Reserve populate (new)

After each `warmed` tick, `worker-cron` calls `rewarmDomain`
(`worker-cron/src/purge.ts`):

1. Build canonical client URLs: `https://tiles.thesurfr.app/data_spatial/<domain>/<runPath>/<vt>.om`
   for each `validTime` within horizon.
2. For each URL, dispatch via the `REWARMER` service binding:
   ```ts
   fetch('https://rewarmer.internal/rewarm?url=...', { ... })
   ```
3. The cron's `/force` endpoint hands the rewarm promise to
   `ctx.waitUntil` so the HTTP response returns immediately after the
   warm step, and the rewarm continues in the background. The scheduled
   handler awaits the rewarm (30 min wall budget).

`worker-rewarmer` per-invocation:

```ts
const res = await fetch(target, {
    method: 'GET',
    cf: { cacheEverything: true, cacheTtl: 30 * 86400 }
});
if (res.body) await res.body.pipeTo(new WritableStream());
```

Each call is a **fresh Worker invocation** with its own 30 s CPU budget,
which lets us drain ~170 MB files without busting any single
invocation's limit. The drain is what triggers CF to finalise the cache
write (including Cache Reserve, when the Cache Rule says eligible).

Hostname allow-list defends against open-proxy abuse:
`{tiles.thesurfr.app, maps.thesurfr.app}`.

### Warming Q&A (specifically asked)

**Fire-and-forget?**

Yes, in two places:
1. The cron's HTTP `/force` handler dispatches `rewarmDomain` via
   `ctx.waitUntil` — HTTP response goes back as soon as the warm step
   finishes (~1-3 min); rewarms continue 5-10 min in the background.
2. Inside `rewarmOne`, the actual rewarm awaits the rewarmer worker's
   response (because we want to know it didn't error). But the rewarmer
   itself drains the body asynchronously via `pipeTo` — it doesn't hold
   per-byte memory.

**Download all (full file) or just metadata (head + tail)?**

**Full file**, not head + tail. CR only stores full 200 responses; a
head + tail probe would create a partial entry that can't satisfy
arbitrary range requests. The rewarmer fetches each file end-to-end and
drains the body via `WritableStream` so CF's cache layer commits the
full object. Bandwidth cost: ~13 GB / full bootstrap across all 13
domains, all intra-CF (no R2 egress charges).

**Mimic the client (Range requests)?**

No. Earlier client-side `pop-warm.ts` used `bytes=-1` suffix probes to
poke CF into populating edge cache for the file's tail range. That
approach was abandoned for two reasons:
1. Range probes only populate per-PoP edge cache, not Cache Reserve.
2. Once CR engaged, the tail-probe pattern was obsolete: CR serves any
   range from the cached full object. Client-side `warmCurrentPoP` is
   now disabled (commented out in `src/routes/+page.svelte:329`).

The cron rewarmer's full-fetch is the single source of CR population.
Per-PoP edge cache fills naturally as users hit each PoP, and is
seeded by the rewarmer's run-after CR populate.

## Consequences

### Wins

- **Cross-PoP first-hit latency**: ~1.5–6 s → ~150–300 ms (CR HIT) for any
  user landing on a fresh PoP after a run swap, once CR is populated.
- **R2 egress drops** on cross-PoP load — CR serves the bulk.
- **Architecture is testable**: each tier has a distinct cache-status
  marker (`HIT-EDGE`, `HIT-R2`, `cf-cache-status: HIT`).

### Costs

- **Cache Reserve add-on plan** required (Smart Shield Advanced or the CR
  standalone billing line). Bypass-without-purchase doesn't error visibly;
  CR just silently doesn't engage. Verify under Billing.
- **Rewarm bandwidth**: ~1 GB per global-model run × ~6-12 runs per day ×
  4 global models ≈ 50-100 GB/day intra-CF. Free at the rewarmer worker;
  no R2 egress (R2 → worker → CF cache is internal).
- **Two cache layers to reason about**: T2a (per-PoP edge) and T2b (CR).
  In practice they're transparent — both serve `cf-cache-status: HIT` —
  but observability tooling needs to know they're distinct.
- **Subdomain split**: cross-origin requests from `maps.` to `tiles.`.
  Wildcard CORS in worker-tiles handles it; embed iframes in the RN
  webview unaffected.

### Risk: Cache Rules vs explicit Cache API

If a future CF docs / behavior change makes Cache Rules sufficient on
Worker responses, the explicit `caches.default.put` becomes redundant.
Leaving it in is harmless; removing it requires verification under load.

## Verification

After deploy + bootstrap warm:

1. **Local edge cache**: hit the same URL twice from the same PoP.
   - First: `x-surfr-cache-status: HIT-R2` (no `cf-cache-status`)
   - Second: `cf-cache-status: HIT` + `Age > 0` + `x-surfr-cache-status: HIT-EDGE`

2. **Range cache**: after a full GET populates the cache, multiple Range
   requests on the same URL all return `x-surfr-cache-status: HIT-EDGE`
   with the requested byte slice.

3. **Cache Reserve**: hit the same URL from a different PoP (use VPN or
   wait for organic traffic). Should see `cf-cache-status: HIT` with
   `Age` reflecting the rewarm time, not seconds-fresh.

4. **Dashboard**: Caching → Cache Reserve → "Egress bytes saved" should
   be > 0 within 24 h of bootstrap warm.

5. **Build + deploy**: `npm run build` (frontend), `npm run deploy` in
   each of `worker-tiles/`, `worker-rewarmer/`, `worker-cron/`. Order:
   rewarmer → cron (depends on REWARMER service binding) → tiles.

## Follow-ups

- Tear out `.om` serving from `functions/tiles/[[path]].ts` after the
  ~5 d transition window. Keep `_warmer-trigger`, `_admin`,
  `_debug/cache`.
- Update ADR 0001 status to "Partially superseded by ADR 0002" once the
  legacy path is removed.
- Decide whether `caches.default.put` is permanent or a workaround. If
  CF clarifies Worker-on-Custom-Domain auto-cache, simplify the worker.
- R2 cleanup of orphan `data_spatial/dwd_icon_eu/` (model dropped earlier;
  R2 prefix never deleted). Manual `wrangler r2 object delete` pass.
