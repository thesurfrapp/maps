# ADR 0001 — Tile caching architecture on Cloudflare

- **Status**: Accepted
- **Last revised**: 2026-05-02
- **Scope**: `functions/tiles/*`, `functions/lib/*`, `worker-tiles/*`,
  `worker-rewarmer/*`, `worker-cron/*`, `src/lib/url.ts`,
  `src/lib/helpers.ts`, `src/lib/pop-warm.ts`, CF Pages project `maps`,
  CF Workers `surfr-tile-server` / `surfr-tile-rewarmer` /
  `surfr-tile-warmer-cron`, R2 bucket `surfr-tile-cache`, CF zone
  `thesurfr.app`.

## Context

The Surfr maps fork renders Open-Meteo's `.om` binary tiles via MapLibre.
Each `.om` is ~20–170 MB; the library reads them with byte-range requests.
Open-Meteo's hosted origin alone gave us 5–10 s first-scrub latencies and
bursty scrubbing stacked sequential ~1 s TTFBs from the user's PoP back to
the upstream AWS bucket.

Goals:

1. Sub-200 ms TTFB for any user, anywhere, on any forecast hour the cron
   has warmed.
2. No stale data after an upstream run publishes.
3. Backwards-compat on URL shape — the runPath segment is part of the URL
   so each run has an immutable cache identity.
4. No client code split per environment / region.
5. Transparent observability: admin dashboard + response headers that
   say where each byte came from.

## Decision

A **five-tier cache stack** on Cloudflare, driven by a 5-min cron that
writes a fresh forecast run into R2 and then populates Cloudflare Cache
Reserve via a companion Worker. URLs include the run path so each run has
an immutable cache identity — no purging needed across run swaps.

```
Client (browser)
  │
  │ T1. Browser cache  (.om: public, max-age=30d, immutable;
  │                     latest.json: no-store)
  │     HIT ─► served from disk
  │     MISS
  ▼
T2a. CF edge cache at user's PoP        (Cache Rule: .om URLs, Edge TTL 30d)
  │     HIT (cf-cache-status: HIT)  ─► ~20-120 ms
  │     MISS
  ▼
T2b. Cache Reserve (global, persistent) (Cache Rule eligibility flag)
  │     HIT (cf-cache-status: HIT, age>0 from any PoP)  ─► ~150-300 ms
  │     MISS
  ▼
worker-tiles (tiles.thesurfr.app, Custom Domain Worker)
        │
        ├── latest.json   ─► R2 only; 503 if missing.
        ├── meta.json     ─► 404 blocked (consolidated onto latest.json).
        ├── in-progress   ─► 404 blocked.
        │
        └── *.om
              1) caches.default.match(rangeStrippedKey)   ─► HIT-EDGE → slice
              2) R2.get(rawPath, { range })               ─► HIT-R2 → 206/200
                                                            (non-Range: also
                                                             waitUntil(cache.put))
              3) R2 MISS ─► fetch(upstream, cf.cacheEverything=true)
                              + waitUntil(warmR2())   — lazy R2 fill
                              ▼
T4. Open-Meteo origin
```

### Five tiers

| Tier | Where | TTL | Populated by |
|---|---|---|---|
| T1 | Browser | `.om`: 30 d + `immutable`. `latest.json`: `no-store`. | Any `.om` HIT response |
| T2a | CF edge cache, per-PoP (~250+ globally) | 30 d (Cache Rule) | `caches.default.put` from `worker-tiles` on full-object miss |
| T2b | Cache Reserve, global persistent | 30 d (Cache Rule eligibility) | `worker-rewarmer` fires `cf.cacheEverything` GETs after each warmed run |
| T3 | R2 bucket `surfr-tile-cache` (ENAM region) | Current run + 2 prior; older pruned per swap | Cron warmer (proactive 72/120 h horizon) + worker-tiles `waitUntil(warmR2)` lazy fill |
| T4 | Open-Meteo origin | n/a | — |

T2a serves repeat hits at the same PoP. T2b serves first hits at any
fresh PoP. Both store the full object — Range requests are sliced on
serve. T3 is the authoritative origin from the user's perspective; T4
is touched only when R2 lacks a file (rare; outside-horizon scrubs).

### Workers — how they work together

Four runtimes, each with a single, narrow job. Diagram first, then the
choreography:

```
                    upstream Open-Meteo
                            ▲
                            │ source-of-truth fetches (R2 fill)
                            │
    ┌───────────────────────┴───────────────────────┐
    │                                               │
    │   maps.thesurfr.app  ──► Pages  ──► functions/lib/warmer.ts
    │                              │           │ ──► R2 writes
    │   ──► SvelteKit frontend     │           │ ──► returns {warmed | unchanged}
    │   ──► /tiles/_warmer-trigger ┘           │
    │   ──► /tiles/_admin                      │
    │   ──► /tiles/_debug/cache                │
    │                                          │
    └────────────────▲─────────────────────────┘
                     │
             HTTP    │ ?domain=X&wait=1
                     │
   worker-cron  ──► CF Worker  (cron */5 * * * *)
                          │
                          │  on status:warmed
                          ▼
                       service binding (REWARMER)
                          │
   worker-rewarmer  ◄────┘  (one URL per invocation,
                              cf.cacheEverything full GET,
                              pipeTo(WritableStream) drain)
                              │
                              ▼
                              │ HTTP request ─────►   ┌────────────────────────┐
                                                      │  tiles.thesurfr.app    │
                                                      │  worker-tiles          │
                                  client browsers ──► │  R2 reads              │
                                                      │  Explicit              │
                                                      │  caches.default.put    │
                                                      └─────────┬──────────────┘
                                                                ▼
                                                              R2 (TILE_CACHE)
                                                              + CF cache layers
                                                                (T2a + T2b)
```

| Runtime | Where | Trigger | Job |
|---|---|---|---|
| Pages frontend | `maps.thesurfr.app` (Pages) | HTTP | SvelteKit UI |
| Pages Function | `maps.thesurfr.app/tiles/*` (Pages) | HTTP | Admin endpoints (`_warmer-trigger`, `_admin`, `_debug`); R2 fill via warmer.ts |
| `worker-tiles` | CF Worker on `tiles.thesurfr.app` (Custom Domain) | HTTP | R2-backed `.om` + `latest.json` serving with Cache API write-through |
| `worker-cron` | CF Worker | `*/5 * * * *` cron + HTTP `/force` | Drives the 5-min poll loop; on `warmed`, dispatches rewarm |
| `worker-rewarmer` | CF Worker | service binding from cron only | One URL per invocation; full fetch + drain to populate T2b |

**Choreography** (5-minute cycle, per-domain):

1. **`worker-cron`** wakes (`*/5 * * * *`) and walks the 13 domains
   sequentially with a 1.5 s pause between each.
2. For each domain, it hits the **Pages Function**
   `maps.thesurfr.app/tiles/_warmer-trigger?domain=X&wait=1`.
3. The Pages Function (`functions/lib/warmer.ts:warmDomain`) is the
   **only place that talks to upstream Open-Meteo**. It fetches
   upstream `latest.json`, compares against R2, and either returns
   `unchanged` (most ticks) or runs the full Stage 1 R2 fill.
4. On `unchanged`, `worker-cron` moves on. No further work.
5. On `warmed`, `worker-cron` dispatches Stage 2 — the Cache Reserve
   populate — by service-binding into `worker-rewarmer` once per
   validTime URL (concurrency 4).
6. **`worker-rewarmer`** has one job per invocation: fetch one URL
   from `tiles.thesurfr.app` with `cf.cacheEverything`, drain the
   body, return a small JSON outcome. Each invocation gets its own
   30 s CPU budget — that's how we drain the 168 MB ICON-Global files.
7. When the rewarmer hits `tiles.thesurfr.app`, the request goes
   through CF edge → `worker-tiles` → R2. `worker-tiles` returns the
   full file; CF caches it per the Cache Rule (T2a + T2b populate).
   On the rewarmer's PoP, T2a fills locally; CR (T2b) propagates
   globally so any other PoP can serve from CR on first hit.

The Pages Function and `worker-tiles` both talk to R2 but with different
intent: the Pages Function is the **writer** (warmer.ts streams from
upstream into R2); `worker-tiles` is the **reader** (range or full reads
out of R2 to serve clients). They share the same R2 binding name
(`TILE_CACHE`) and bucket (`surfr-tile-cache`).

### Why a separate Worker for tile-serving

Cache Reserve is **bypassed** for any traffic that goes through Cloudflare
Pages's Orange-to-Orange (O2O) path. A custom domain on a Pages project
necessarily routes via the pages.dev zone (a separate Cloudflare zone),
and CR is documented as bypassed for that hop. We had CR enabled for
months with `Egress bytes saved: 0 B`, every cross-PoP request returning
`cf-cache-status: MISS` despite an aggressive pre-warmer.

Workers on a Custom Domain run **directly on the zone** — no second-zone
hop, CR engages. Hence `worker-tiles` lives on `tiles.thesurfr.app` and
serves all `.om` and `latest.json` traffic. The Pages Function still
exists at `maps.thesurfr.app/tiles/*` for admin endpoints (and historical
backwards compat that can be removed in a follow-up).

Subdomain choice: Workers and Pages can't both have a Custom Domain on the
same hostname. `maps.` is bound to Pages; `tiles.` is the new Worker
binding. `wrangler deploy` auto-provisions DNS + cert via the
`[[routes]] custom_domain = true` entry in `worker-tiles/wrangler.toml`.

### Why `caches.default.put` is explicit in the Worker

Empirically, **Cache Rules alone don't engage the cache layer for Worker
responses on a Custom Domain**. With the rule correctly configured
(`Eligible for cache`, `Eligible for Cache Reserve`, `≥1 MB min`), CF
returned no `cf-cache-status` header at all — meaning the cache layer
wasn't consulted. The Worker has to call `caches.default.put()` itself;
the rule applies on the put, not on the response stream.

So `worker-tiles` does:

1. `caches.default.match(cacheKey)` — Tier 1 lookup. Hit → slice + return.
2. On miss + non-Range: `R2.get(key)` for the full object, return to client,
   `ctx.waitUntil(caches.default.put(cacheKey, fullResponse.clone()))`.
   The put through the Cache API is what triggers the Cache Rule (T2a +
   T2b populate).
3. On miss + Range: `R2.get(key, range)` partial read, return 206. **No
   cache write** — partials can't seed CR, which only stores full 200s.

Cache key is **range-stripped** (URL only) so all Range variants share
one entry. `sliceCachedFull` reads the cached body into a `Uint8Array`,
takes a subarray, and synthesises a 206 with `Content-Range`. Memory-
bound by file size; .om files cap at ~170 MB which fits inside the
Worker's heap because the Cache API streams.

If a future CF docs / behavior change makes Cache Rules sufficient, the
explicit put becomes redundant. It's harmless to leave in.

### Client URL shape

```
GET https://tiles.thesurfr.app/data_spatial/<domain>/YYYY/MM/DD/HHmmZ/<validTime>.om
GET https://tiles.thesurfr.app/data_spatial/<domain>/latest.json
```

The runPath segment (`YYYY/MM/DD/HHmmZ`) is included. Each run has a
unique, immutable URL — ETag is stable, `Range` requests always return
206, browsers cache `.om` bytes with `immutable` and never revalidate.

Frontend constants:
- `src/lib/helpers.ts:getBaseUri()` → `'https://tiles.thesurfr.app'`
- `src/lib/pop-warm.ts:META_BASE` → `'https://tiles.thesurfr.app/data_spatial'`

Clients derive the runPath from R2 `latest.json` on page load
(`src/lib/url.ts:getOMUrl` / `getNextOmUrls` → `fmtModelRun`). The Worker
serves `.om` requests directly from R2 at the exact key — no rewriting.

### Users cannot pick a run

The Surfr product only cares about "the latest run that is fully warmed
on our R2". There is no UI or URL parameter to select a different run:

- No `?model_run=` URL param handling.
- No model-run dropdown, lock button, or prev/next-run keyboard shortcuts
  in `src/lib/components/time/time-selector.svelte`.
- `modelRun` on the client is always `latest.reference_time` from R2.

### Pointer file — `latest.json`

Served **exclusively from R2**, with `Cache-Control: no-store`. If R2 has
no object, the worker returns `503 Service Unavailable` + `Retry-After:
60`. No origin fallback.

R2-only serving guarantees that clients only ever see a `reference_time`
whose horizon of `.om` files is already in R2 (the warmer writes
`latest.json` after all `.om` files for the run have been PUT).
`no-store` prevents the browser or any cache from holding a stale pointer
that could let the client build a runPath URL for a run we've pruned.

`latest.json` carries `reference_time`, `valid_times`, and `variables` —
everything the client needs. Upstream's `meta.json` is byte-identical so
we consolidated on `latest.json` only. `meta.json` and `in-progress.json`
both return `404 blocked` (`isBlockedJson` in `worker-tiles/src/index.ts`
and `functions/tiles/[[path]].ts`).

### End-to-end invariant

> If a client sees a `reference_time` in `latest.json`, every `.om` URL
> derived from it (domain × runPath × validTime within the configured
> horizon) is already in R2.

Because:
1. The warmer PUTs `latest.json` only **after** every `.om` for the run
   is in R2 (`functions/lib/warmer.ts`, after all timeout / fail /
   tail-404 guards).
2. `latest.json` is R2-only and never browser- or edge-cached.
3. `meta.json` and `in-progress.json` are 404'd — no side channel for a
   client to learn about a run our R2 doesn't have.
4. Old runs stay on R2 for 2 swaps beyond the one that retired them, so
   in-flight tabs holding an older runPath still resolve.

### The horizon: 72 h vs 120 h

The cron warmer caps per-domain warming by **forecast horizon**, defined
in `functions/lib/warmer.ts`:

- **Default 72 h** for regional / fast-publishing models (most users
  scrub within ±48 h; warming the full 10-day horizon balloons R2 writes
  with low payoff).
- **Extended 120 h (5 d)** for global models where users plan further
  out: `EXTENDED_HORIZON_DOMAINS` = `{ ncep_gfs013, ncep_gfs025,
  ecmwf_ifs025, dwd_icon, dwd_icon_d2 }`.

Inside the horizon: R2 has the file. Worker serves from R2 (`HIT-R2`,
~100–500 ms, cached at T2a after first hit per PoP). After CR populates
(see "Update flow"), even cross-PoP first hits are T2b (~150–300 ms).

Outside the horizon: client request → all cache tiers MISS → worker
falls through to `fetch(upstream, cf.cacheEverything=true)`. The origin
response streams back to the client; in parallel `waitUntil(warmR2)`
fires an independent full-body fetch and streams it into R2. Subsequent
users at the same PoP HIT the edge; users at other PoPs incur one R2 read
each. Outside-horizon URLs reach the same steady state as in-horizon URLs
after one user touches them.

### Update flow on a new Open-Meteo run

`worker-cron` fires every 5 min (`*/5 * * * *`). It walks the 13 domains
sequentially, one HTTP call per domain to
`https://maps.thesurfr.app/tiles/_warmer-trigger?domain=<d>&wait=1`.

Inside the Pages Function (`functions/lib/warmer.ts:warmDomain`):

1. Fetch upstream `latest.json`.
2. Compare `reference_time` with R2's `latest.json`.
3. If unchanged → return `{ status: 'unchanged' }` and stop.
4. Otherwise:
   - Fetch upstream `meta.json` (server-side only) for the full
     `valid_times` list.
   - Cap `valid_times` to the per-domain horizon (72 h or 120 h).
   - Warm each capped validTime to R2, concurrency 4 (stop-on-404 if
     upstream is still uploading; skip already-in-R2 via `head`;
     per-domain 4-min deadline).
   - If any file failed, the run timed out, or the tail 404s — bail
     **without** swapping. Next tick resumes from where we left off;
     `head` skip makes it cheap.
   - **Atomic swap**: one PUT of `latest.json` to R2. Clients see the new
     run only after this completes.
   - `pruneOldRunFiles`: list `.om` keys under `data_spatial/<domain>/`,
     group by runPath, keep newest 3 (current + 2 prior), delete the rest.
   - Return `{ status: 'warmed', referenceTime, validTimes, files,
     prunedOldFiles, keptRunPaths }`.

After a `warmed` result, `worker-cron` dispatches the **rewarm**
(`worker-cron/src/purge.ts:rewarmDomain`):

1. Build canonical client URLs: `https://tiles.thesurfr.app/data_spatial/<domain>/<runPath>/<vt>.om`
   for each capped validTime.
2. For each URL, dispatch via the `REWARMER` service binding:
   ```ts
   fetch('https://rewarmer.internal/rewarm?url=...')
   ```
3. The cron's HTTP `/force` handler hands the rewarm promise to
   `ctx.waitUntil` so the response returns immediately after the warm
   step (~1-3 min); rewarms continue 5-10 min in the background. The
   scheduled handler awaits the rewarm (30 min wall budget).

`worker-rewarmer` per-invocation (`worker-rewarmer/src/index.ts`):

```ts
const res = await fetch(target, {
    method: 'GET',
    cf: { cacheEverything: true, cacheTtl: 30 * 86400 }
});
if (res.body) await res.body.pipeTo(new WritableStream());
```

Each call is a **fresh Worker invocation** with its own 30 s CPU budget,
which lets us drain ~170 MB files without busting any single
invocation's limit. The drain through `pipeTo(WritableStream())` is what
triggers CF to finalise the cache write — both T2a (per-PoP edge) and
T2b (Cache Reserve) populate, gated by the Cache Rule's eligibility
settings.

Hostname allow-list defends against open-proxy abuse:
`{ tiles.thesurfr.app, maps.thesurfr.app }`.

#### Warming Q&A (commonly asked)

- **Fire-and-forget?** Yes. The cron's HTTP `/force` returns as soon as
  the warm step finishes; rewarms continue via `ctx.waitUntil`. Inside
  `rewarmOne`, the actual rewarmer-worker call is awaited so we know if
  it errored, but the body drain itself is `pipeTo(WritableStream())` —
  no per-byte buffering.
- **Download all (full file) or head + tail?** **Full file**. CR only
  stores full 200 responses; a head + tail probe would create a partial
  cache entry that can't satisfy arbitrary Range requests. Bandwidth
  cost: ~13 GB / full bootstrap across all 13 domains, all intra-CF.
- **Mimic the client (Range probes)?** No. Earlier client-side
  `pop-warm.ts` used `bytes=-1` suffix probes to poke CF into populating
  edge cache for the file's tail. That approach was abandoned: Range
  probes only populate per-PoP edge, not Cache Reserve, and once CR
  engaged the tail-probe pattern was obsolete since CR serves any range
  from the cached full object. Client-side `warmCurrentPoP` is now
  disabled (`src/routes/+page.svelte:329`, commented out).

Because every URL a client builds includes the runPath, a new run
produces entirely new URL strings — the previous run's cached entries
simply go unused and age out at the 30 d Cache Rule TTL. Nothing needs to
be explicitly evicted.

### Manual recovery

`GET https://surfr-tile-warmer-cron.herbert-0fd.workers.dev/force?domain=<d>`
re-runs the warmer for one domain with the "already up-to-date"
short-circuit disabled (`functions/tiles/_warmer-trigger.ts?force=1` →
`warmDomain(env, domain, { force: true })`). The warmer re-fetches
upstream `meta.json`, re-verifies each `.om` is in R2 (`head` check skips
files already present), re-PUTs `latest.json`, re-prunes, and dispatches
a rewarm. Use when a prior warm looks bad and you want to re-verify
everything end-to-end.

The admin dashboard has a per-domain "Force warm" button that hits the
same endpoint.

### Cache Rules

CF defaults to `cf-cache-status: DYNAMIC` for `.om` files (not in the
default-cacheable extension list) and for Worker responses (treated as
"computed"). One zone-level rule unlocks both:

```
name:        cache-om-tiles
expression:  ((http.host eq "tiles.thesurfr.app"
              or http.host eq "maps.thesurfr.app")
              and ends_with(http.request.uri.path, ".om"))
cache:       Eligible for cache
edge TTL:    Use cache-control header if present, default TTL otherwise
browser TTL: Respect origin TTL
CR:          Eligible for Cache Reserve, min file size 1 MB
order:       first
```

Without this rule, every `.om` hit either reaches the worker (and the
Cache API put silently no-ops on the CR write side) or — for legacy
Pages-served URLs during the transition — falls through with no caching.

Cache Reserve also requires the **paid Cache Reserve add-on**
(or Smart Shield Advanced bundle) on the zone. Bypass-without-purchase
is silent — CR just doesn't engage.

### Admin dashboard

`https://maps.thesurfr.app/tiles/_admin` — HTML page (no auth, read-only),
generated by `functions/tiles/_admin.ts`.

Per domain it shows:
- Status pill: OK / STALE / COLD / UNKNOWN.
- Our R2 `latest.json` `reference_time` + mismatch against upstream.
- Number of `.om` files in R2 for the current run + total MB.
- Oldest / newest validTime in R2.
- Historical runs column — retained prior runs (runPath + file count + MB).
- "Last tick" — age and status of the most-recent per-domain warm.
- "Force warm" button → cron `/force?domain=<d>` endpoint.

Top of page: collapsible "Last cron" details from
`_warmer/last-tick.json`.

Related endpoints:

- `/tiles/_warmer-trigger?domain=<d>&wait=1` — run warmer for one domain,
  wait for result.
- `/tiles/_warmer-trigger` — run all domains, fire-and-forget.
- `/tiles/_debug/cache` — JSON inventory of R2 keys grouped by prefix.
- `https://surfr-tile-warmer-cron.herbert-0fd.workers.dev/force?domain=<d>`
  — re-run warmer + dispatch rewarm. Bypasses unchanged short-circuit.

### Run-date label

`src/lib/components/run-date-label.svelte` — small fixed-position label
at `top: 120 px, left: 50%` showing `Run YYYY-MM-DD HH:MMZ`. Rendered in
both standalone and `?embed=1` modes so users can see which run their
tiles came from. The pop-warm toast `z-index: 110` overlays this label
when warming (`src/lib/components/pop-warm-toast.svelte:70`).

### PoPs and edge warming

**PoP** = Cloudflare Point of Presence (a datacenter). CF has 250+
worldwide; every user is latency-routed to the closest one.

How edge cache gets warmed at a PoP for a new run:

1. **Cron rewarm** completes within ~5-10 min of a `warmed` result. The
   `cf.cacheEverything` GET from `worker-rewarmer` writes to T2a (the
   PoP that handled the rewarm) AND T2b (Cache Reserve, global).
2. **First user at a fresh PoP** (one that didn't handle the rewarm):
   T2a MISS → T2b HIT → ~150-300 ms response. T2a populates from T2b for
   subsequent local hits.
3. **Subsequent users at same PoP**: T2a HIT, ~20-120 ms.

Range requests served from T2a/T2b: the full object is cached once;
all Range variants slice from it. Inside `worker-tiles`, the
range-stripped cache key + `sliceCachedFull` does the slicing for hits
that reach the Worker (only on T2a/T2b miss).

### Latency profile

- **p50 TTFB on `.om` ranges**: ~20–120 ms (T2a edge HIT, most traffic).
- **p90 TTFB**: ~150–300 ms (T2b Cache Reserve HIT, first hit at fresh
  PoP after rewarm).
- **p99 TTFB**: ~400-800 ms (T3 R2 read, rare — only before rewarm
  completes for the run, or for files not yet in CR).
- **p99.9 TTFB** (outside-horizon, never-warmed URL): ~1–2 s origin
  round-trip.

## Observability

Response headers on `.om` responses carry enough telemetry to diagnose
any tier in the stack.

| Header | Who sets | Meaning |
|---|---|---|
| `cf-cache-status: HIT` | CF edge (authoritative) | Served from T2a or T2b. Worker code didn't run on this request. |
| `cf-cache-status: MISS` | CF edge | Cache layer didn't have it; worker ran. |
| `cf-cache-status: DYNAMIC` | CF edge | URL wasn't eligible for cache — Cache Rule didn't match. Investigate. |
| `cf-cache-status: (absent)` | — | Cache layer wasn't engaged at all. Indicates Cache Rule misconfiguration or `caches.default.put` not firing in the worker. |
| `Age: N` | CF edge | Seconds since cache populate. `Age: 0` on a HIT = fresh upper-tier→edge fill (regional / Cache Reserve→PoP). `Age > 0` = local edge had it cached. |
| `X-Surfr-Cache-Status: HIT-EDGE` | worker-tiles | Tier 1 (worker's `caches.default`) hit. |
| `X-Surfr-Cache-Status: HIT-R2` | worker-tiles | Worker fell through to R2 read. |
| `X-Surfr-Cache-Status: HIT-ORIGIN-EDGE` | worker-tiles / Pages Function | Origin fetch came back from CF's edge cache of the upstream URL (fast). |
| `X-Surfr-Cache-Status: MISS-ORIGIN` | worker-tiles / Pages Function | Origin round-trip; R2 was cold too. |
| `X-Surfr-Upstream-Ms` | worker-tiles / Pages Function | Time spent on the origin fetch, if any. |

Distinguishing T2a vs T2b on a `cf-cache-status: HIT`:
- **`Age` close to `0`** + `cf-cache-status: HIT` = most likely a fresh
  T2b → T2a fill, i.e. Cache Reserve is serving a PoP that didn't have
  it locally yet.
- **`Age` reflecting rewarm time** (minutes-to-hours since last
  `warmed` tick) + HIT = T2a settled local edge cache.

Debug URLs:
- `/tiles/_admin` — HTML dashboard.
- `/tiles/_debug/cache` — JSON inventory.
- `/tiles/_debug/cache?prefix=data_spatial/dwd_icon/` — filter.

## Capacity and cost

- **CF Pages**: free tier hosts the SvelteKit frontend + admin Pages
  Functions.
- **Workers Paid** ($5/mo) required for the subrequest budget that
  `warmDomain` (Pages Function) and the 13× rewarm dispatches use.
- **Cache Reserve** add-on plan required for T2b. Bypass-without-plan
  is silent — verify under Billing.
- **R2** `surfr-tile-cache`, location ENAM, no jurisdiction. All warmer
  traffic (cron → Pages Function → R2 → worker → CF cache) is internal
  to CF → **zero R2 egress fees**. Client traffic never reads R2
  directly — always via the worker, which is CF-internal from R2's
  perspective.
- **Cron load**: 288 ticks/day × 13 domain HTTP calls = ~3.7 k
  requests/day to the Pages Function. Most ticks are no-ops (`unchanged`
  short-circuit).
- **Rewarm bandwidth**: ~1 GB per global-model run × ~6-12 runs per day
  × 4 global models ≈ 50–100 GB/day intra-CF (no R2 egress, no client
  bandwidth).

Model run cadences and approximate warm volumes per swap:

| Domain family | New run | Warm volume / swap |
|---|---|---|
| NCEP HRRR CONUS | hourly | ~1 GB internal |
| NCEP GFS 0.13/0.25 | 4×/day | ~5 GB internal |
| DWD ICON family | 4×/day | ~3 GB internal |
| ECMWF IFS 0.25 | 4×/day | ~3 GB internal |
| MetOffice, Météo-France, MetNo, KNMI, CMC | 2–8×/day | ~1 GB internal |

13 active domains; `dwd_icon_eu` was dropped (commented out in the RN
frontend's `FORECAST_MODELS`).

## Consequences

### Wins

- **Cross-PoP first hits**: ~1.5–6 s (R2 round-trip) → ~150–300 ms
  (Cache Reserve HIT) for any user landing on a fresh PoP after a run
  swap.
- **R2 egress drops** on cross-PoP load — CR serves the bulk.
- **Stale data is impossible**: every `.om` URL is immutable
  (runPath-keyed); `latest.json` is R2-only + never cached.
- **Tabs left open across a run swap keep working** (2 prior runs
  retained).
- **Architecture is testable**: each tier has a distinct cache-status
  marker (`HIT-EDGE`, `HIT-R2`, `cf-cache-status: HIT` / `MISS`).
- **One code base, one deploy pipeline, one R2 bucket, four Cloudflare
  runtimes** with clear separation of concerns.

### Costs

- **Cache Reserve add-on** required for T2b — silent failure if not
  active.
- **Rewarm bandwidth**: ~50-100 GB/day intra-CF. Free at the runtime
  layer, but visible in metrics.
- **Two cache layers** (T2a + T2b) to reason about. Distinguish via
  `Age` header.
- **Subdomain split**: cross-origin from `maps.` to `tiles.`. Wildcard
  CORS in `worker-tiles` handles it; embed iframes in the RN webview
  unaffected.
- **Worker-on-Custom-Domain quirk**: explicit `caches.default.put`
  required (Cache Rules alone don't engage). Documented above; if CF
  changes that behavior, the put becomes a no-op safety net.

## Follow-ups

- Tear out `.om` serving from `functions/tiles/[[path]].ts` after the
  ~5-day backwards-compat window; keep `_warmer-trigger`, `_admin`,
  `_debug/cache` on Pages.
- R2 cleanup of orphan `data_spatial/dwd_icon_eu/` prefix (model dropped;
  R2 prefix never deleted). Manual `wrangler r2 object delete` pass.
- Decide whether `caches.default.put` is permanent or a workaround. If
  CF clarifies Worker-on-Custom-Domain auto-cache, simplify the worker.

## References

### Code

- `worker-tiles/src/index.ts` — tile-serving Worker (T2a/T2b populate via
  Cache API + R2 reads + upstream fallback).
- `worker-rewarmer/src/index.ts` — single-URL CR populator (drained
  `cf.cacheEverything` GETs).
- `worker-cron/src/index.ts` — cron scheduler + `/force?domain=X`.
- `worker-cron/src/purge.ts` — `rewarmDomain` dispatcher (per-domain
  rewarm via REWARMER service binding).
- `functions/tiles/[[path]].ts` — Pages Function tile proxy (legacy +
  admin path support).
- `functions/tiles/_warmer-trigger.ts` — HTTP entry for the warmer.
- `functions/tiles/_admin.ts` — HTML dashboard.
- `functions/lib/warmer.ts` — per-domain warm logic, atomic swap,
  retention pruning, horizon caps.
- `functions/lib/domains.ts` — the 13 warmed domain names.
- `src/lib/url.ts` — client URL builder (runPath included).
- `src/lib/helpers.ts:getBaseUri` — `tiles.thesurfr.app` base URI.
- `src/lib/metadata.ts` — `latest.json` fetch + metadata derivation.
- `src/lib/pop-warm.ts` — per-session PoP warm (currently disabled at
  the call site; kept in place for re-enable if CR proves unreliable).
- `src/lib/components/run-date-label.svelte` — run-date label widget.

### CF dashboard

- Zone `thesurfr.app` → DNS → `tiles` (CNAME, auto-managed by wrangler).
- Zone → Caching → Cache Rules → `cache-om-tiles`.
- Zone → Caching → Cache Reserve (toggle + add-on plan).
- Workers → `surfr-tile-server` (worker-tiles) → custom domain
  `tiles.thesurfr.app`.
- Workers → `surfr-tile-rewarmer` (worker-rewarmer) → no triggers,
  service-bound only.
- Workers → `surfr-tile-warmer-cron` (worker-cron) → `*/5 * * * *` cron
  + REWARMER service binding to surfr-tile-rewarmer.
- Pages → `maps` → custom domain `maps.thesurfr.app` → R2 binding
  `TILE_CACHE = surfr-tile-cache`.
