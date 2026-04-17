# ADR 0001 — Tile caching architecture on Cloudflare

- Status: Accepted
- Scope: `functions/tiles/*`, `functions/lib/*`, `worker-cron/*`, `src/lib/url.ts`,
  `src/lib/stores/om-protocol-settings.ts`, CF Pages project `maps`, CF Worker
  `surfr-tile-warmer-cron`, R2 bucket `surfr-tile-cache`, CF zone `thesurfr.app`.

## Context

The Surfr maps fork renders Open-Meteo's `.om` binary tiles via MapLibre. Each
`.om` is ~20–110 MB; the library reads them with byte-range requests. With
Open-Meteo's hosted origin as the sole backend we observed 5–10 s first-scrub
latencies, and bursty scrubbing frequently stacked sequential ~1 s TTFBs from
the user's PoP back to Open-Meteo's AWS bucket. Cloudflare Cache Reserve would
solve it in one line but is gated behind Smart Shield Advanced at $50/mo.

Goals:
1. Sub-100 ms TTFB for repeat scrubs in the same region (edge-served).
2. No stale data after an upstream run publishes.
3. Free-tier-friendly cost.
4. No client code split per environment / region.
5. Transparent observability: admin dashboard + response headers that say
   where a byte came from.

## Decision

A **four-tier cache stack** on Cloudflare, driven by a 5-min cron that writes
to an R2 bucket and invalidates the CF edge cache on every upstream run swap.
Every `.om` and `latest.json` request funnels through a Pages Function at
`maps.thesurfr.app/tiles/*`.

```
Client (browser)
  │
  │ 1. Browser cache   (.om: public, max-age=30d, immutable;
  │                     latest.json: no-store)
  │     HIT ─► served from disk
  │     MISS
  ▼
CF edge cache at user's PoP    (Cache Rule: .om URLs, Edge TTL 30d)
  │     HIT (CF-Cache-Status: HIT)  ─► ~20-120 ms, no origin touched
  │     MISS
  ▼
Pages Function
        │
        ├── latest.json   ─► R2 only; 503 if missing.
        ├── meta.json     ─► 404 blocked (consolidated onto latest.json).
        ├── in-progress   ─► 404 blocked (upstream WIP run, not on our R2).
        │
        └── *.om:
              1) R2.get(rawPath, { range })      ─► HIT-R2 → 206/200
              2) R2 MISS ─► fetch(upstream, cf.cacheEverything=true)
                            + waitUntil(warmR2())   — lazy R2 fill
                            │
                            ▼
                          Open-Meteo origin
```

### Four tiers

| Tier | Where | TTL | Populated by |
|---|---|---|---|
| T1 | Browser | `.om`: 30 d + `immutable` (URL uniquely identifies a run, bytes never change). `latest.json`: `no-store`, never cached. | Any `.om` HIT response |
| T2 | CF edge (per-PoP, + Smart Tiered Cache upper tier) | 30 d from the Cache Rule, which ignores `Cache-Control` on `.om`. | First user at each PoP; invalidated globally by cron on run swap |
| T3 | R2 bucket `surfr-tile-cache` (ENAM region) | Current run + 2 prior runs retained; older pruned on each warm swap. | Cron warmer (proactive, 72 h horizon) + Pages Function `waitUntil(warmR2)` lazy fill (files outside the horizon) |
| T4 | Open-Meteo origin | n/a | — |

### Client URL shape

```
GET /tiles/data_spatial/<domain>/YYYY/MM/DD/HHmmZ/<validTime>.om
```

The runPath segment (`YYYY/MM/DD/HHmmZ`) is included. Each run has a unique,
immutable URL — ETag is stable, `Range` requests always return 206, browsers
can cache the bytes with `immutable` and never revalidate.

Clients derive the runPath from our R2 `latest.json` on page load
(`src/lib/url.ts:getOMUrl` / `getNextOmUrls` → `fmtModelRun`). The Pages
Function serves `.om` requests directly from R2 at the exact key — no
server-side rewriting.

### Users cannot pick a run

The Surfr product only cares about "the latest run that is fully warmed on
our R2". There is no UI or URL parameter to select a different run:

- No `?model_run=` URL param handling.
- No model-run dropdown, lock button, or prev/next-run keyboard shortcuts
  in `src/lib/components/time/time-selector.svelte`.
- `modelRun` on the client is always `latest.reference_time` from our R2.

### Pointer file — `latest.json`

`latest.json` is served **exclusively from R2**, with `Cache-Control:
no-store`. If R2 has no object, the Pages Function returns `503
Service Unavailable` + `Retry-After: 60`. No origin fallback.

Serving from R2 only guarantees that clients only ever see a `reference_time`
whose 72 h of `.om` files are already in R2 (the warmer writes `latest.json`
after all `.om` files for the run have been PUT). `no-store` prevents the
browser or CF edge from caching a pointer that moves between runs — a stale
pointer would let the client build a runPath URL for a run we've pruned.

`latest.json` carries `reference_time`, `valid_times`, and `variables` —
everything the client needs. Upstream's separate `meta.json` is byte-identical
to `latest.json`, so we consolidated on `latest.json` only. `/meta.json` and
`/in-progress.json` both return `404 blocked` from the Pages Function
(`isBlockedJson` in `functions/tiles/[[path]].ts`).

Code: `functions/tiles/[[path]].ts:R2_JSON_KEY` + `serveJsonFromR2`.

### End-to-end invariant

> If a client sees a `reference_time` in `latest.json`, every `.om` URL
> derived from it (domain × runPath × validTime within the 72 h horizon)
> is already in R2.

Because:
1. The warmer PUTs `latest.json` only **after** every `.om` for the run is
   in R2 (`functions/lib/warmer.ts`, after all timeout / fail / tail-404
   guards).
2. `latest.json` is R2-only and never browser- or edge-cached.
3. `meta.json` and `in-progress.json` are 404'd — no side channel for a
   client to learn about a run our R2 doesn't have.
4. Old runs stay on R2 for 2 swaps beyond the one that retired them, so
   in-flight tabs holding an older runPath still resolve.

### The 72 h window and what happens outside it

The cron warmer caps per-domain warming at **72 hours** of forecast horizon
from the run's `reference_time` (`MAX_HORIZON_HOURS` in
`functions/lib/warmer.ts`). Rationale: most users scrub within ±48 h; warming
the full 10-day GFS horizon would balloon R2 writes with low payoff.

**Inside the 72 h window:**
- R2 has the file. Pages Function serves from R2 (HIT-R2 ~100–500 ms).
- After purge-on-swap, first user at a cold PoP pays one R2-read;
  subsequently CF edge HIT (~20–120 ms).

**Outside the 72 h window:**
1. Client request → CF edge MISS → Pages Function.
2. `R2.get` → null.
3. Falls through to `fetch(upstream, cf.cacheEverything=true)`. Origin
   response streams back to the client — their specific range is served,
   nothing blocks.
4. **In parallel, via `waitUntil`**, `warmR2` fires an independent
   `fetch(upstream)` with no Range header and streams the full body into
   R2 via `TILE_CACHE.put`. Client doesn't wait. (Guarded by a `head`
   check to avoid duplicate puts on concurrent misses.)

End state after one user hits an outside-horizon URL at PoP X:
- **CF edge at PoP X has the full file cached** (thanks to
  `cacheEverything` + our Cache Rule). Subsequent range requests to this
  URL at PoP X are edge HITs.
- **R2 has the full file.** A user at a different PoP Y still incurs an
  edge MISS at Y, but now HITs R2 (~400 ms) instead of origin (~1 s).

Outside-horizon URLs reach the same steady state as in-horizon URLs after
one user touches them at each PoP.

### Update flow on a new Open-Meteo run

The cron fires every 5 min (CF Workers cron `*/5 * * * *` on
`surfr-tile-warmer-cron`). It walks the 14 domains sequentially, one HTTP
call per domain to
`https://maps.thesurfr.app/tiles/_warmer-trigger?domain=<d>&wait=1`.

Inside the Pages Function (`functions/lib/warmer.ts:warmDomain`):

1. Fetch upstream `latest.json`.
2. Compare `reference_time` with R2's `latest.json`.
3. If unchanged → return `{ status: 'unchanged' }` and stop.
4. Otherwise:
   a. Fetch upstream `meta.json` for the new run (server-side only, to get
      the full `valid_times` list).
   b. Cap `valid_times` to +72 h from `reference_time`.
   c. Warm each capped validTime to R2 with concurrency 4 (stop-on-404 if
      upstream is still uploading, skip already-in-R2 via `head`,
      per-domain 4 min deadline).
   d. If any file failed, the run timed out, or the tail 404s (model still
      uploading) — bail **without** swapping. Next tick resumes from where
      we left off; `head` skip makes it cheap.
   e. **Atomic swap**: one PUT of `latest.json` to R2. Clients see the new
      run only after this completes.
   f. `pruneOldRunFiles`: list all `.om` keys under `data_spatial/<domain>/`,
      group by runPath, keep newest 3 (current + 2 prior), delete the rest.
   g. Return `{ status: 'warmed', referenceTime, validTimes, files, prunedOldFiles, keptRunPaths }`.

The cron worker does no further work after a `warmed` result. Because
every URL a client builds includes the runPath (the immutable per-run
segment `YYYY/MM/DD/HHmmZ`), a new run produces entirely new URL strings
and the previous run's edge-cached URLs are simply never requested again
— they age out at the 30 d Cache Rule TTL. Nothing needs to be explicitly
evicted.

Code:
- `worker-cron/src/index.ts` — cron driver (every 5 min) + `/force?domain=X`
  endpoint for manual recovery. No Cloudflare API dependencies.

### Manual recovery

`GET https://surfr-tile-warmer-cron.herbert-0fd.workers.dev/force?domain=<d>`
re-runs the warmer for one domain with the "already up-to-date" short-
circuit disabled (`functions/tiles/_warmer-trigger.ts?force=1` →
`warmDomain(env, domain, { force: true })`). The warmer re-fetches upstream
meta.json, re-verifies each `.om` is in R2 (`head` check skips files
already present, so this is cheap), re-PUTs `latest.json`, and re-prunes.
Use when a prior warm looks bad and you want to re-verify everything.

The admin dashboard has a per-domain "Force warm" button that hits the
same endpoint.

### The Cache Rule

Pages Function responses default to `CF-Cache-Status: DYNAMIC`, meaning CF
skips the edge cache entirely. `Cache-Control: public, max-age=…` from the
function is not enough — CF only caches file types it recognises as static
by default, and `.om` isn't one of them.

One-time dashboard setup (zone `thesurfr.app`, Caching → Cache Rules):

```
name:        cache-om-tiles
expression:  (http.host eq "maps.thesurfr.app"
              and ends_with(http.request.uri.path, ".om"))
cache:       Eligible for cache
edge TTL:    30 days, ignore origin Cache-Control
browser TTL: respect origin (we send max-age=2592000, immutable)
order:       first (before any broader rule)
```

Without this rule, every `.om` hit reaches the Pages Function.

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

At the top a collapsible "Last cron" details block shows the most recent
`_warmer/last-tick.json`.

Related endpoints:
- `/tiles/_warmer-trigger?domain=<d>&wait=1` — run warmer for one domain,
  wait for result.
- `/tiles/_warmer-trigger` — run all domains, fire-and-forget.
- `/tiles/_debug/cache` — JSON inventory of R2 keys grouped by prefix.
- `https://surfr-tile-warmer-cron.herbert-0fd.workers.dev/force?domain=<d>`
  — force a CF cache purge for one domain's current run.

### Run-date label

`src/lib/components/run-date-label.svelte` — a small fixed-position label
at `top: 120px, left: 50%` showing `Run YYYY-MM-DD HH:MMZ`. Rendered in
both standalone and `?embed=1` modes so mobile users can see which run
their tiles came from. Shares the 120 px slot with the pop-warm toast; the
toast overlays the label while warming.

## PoPs and edge warming

**PoP** = Cloudflare Point of Presence, a datacenter. CF has ~250+ worldwide;
every user is latency-routed to the closest one. **Edge cache is per-PoP** —
a HIT at PoP A does not benefit PoP B.

**The cron worker runs at one PoP** (wherever CF schedules it). When the
cron fires a purge, the purge is global, so every PoP drops the stale entry.
When the cron *could* re-warm, it would only warm its own PoP (and, via
Smart Tiered Cache, the upper tier). Cache Reserve — the global persistent
tier that would make a single re-warm fetch meaningful for every PoP —
currently does not catch our traffic (support ticket is open). The cron is
therefore **purge-only, no re-warm**.

How edge cache actually gets warmed at other PoPs:

1. **First user at a cold PoP**: range request → CF edge MISS → Pages
   Function → R2 → 206 response. CF caches the full file (cache-on-range
   behavior) and the range response goes back. ~400–1600 ms.
2. **Subsequent users at that PoP**: CF edge HIT. ~20–120 ms.

**CF cache-on-range behavior**: when a range request lands on a cacheable
URL that's not yet cached, CF fetches the **full** resource from origin,
caches it, and serves the requested range out of that cached full copy. So
any range request (including our library's small header/footer probes) acts
as a full-file warmer for that URL at that PoP.

**The prefetch — per-PoP self-warming.** The client-side
`postReadCallback` in `src/lib/stores/om-protocol-settings.ts` fires, after
every successful `.om` read, a probe against the prev/next-hour file:

```ts
omFileReader.setToOmFile(nextOmUrl);
omFileReader.prefetchVariable('not_a_real_variable', null, signal);
```

`'not_a_real_variable'` makes the library read only the header + footer
(~70 KB combined) and stop — no data blocks fetched. From CF's point of
view, that range request against an uncached cacheable URL triggers a full
26 MB fetch + edge cache. Side effect: by the time the user scrubs to hour
T+1, the PoP already has the full T+1 file cached.

We cancel the in-flight prefetch via an `AbortController` on every new
`postReadCallback` so fast-scrubbing users don't back up HTTP/2 streams
behind a slow prefetch.

### Latency profile

- **p50 TTFB on `.om` ranges**: ~20–120 ms (edge HIT, most traffic).
- **p99 TTFB**: ~400–600 ms (first user at a PoP, freshly-purged URL, R2
  read — `X-Surfr-Cache-Status: HIT-R2`, `CF-Cache-Status: MISS`).
- **p99.9 TTFB** (outside-horizon, never-warmed URL): ~1–2 s origin round
  trip.

First-user-per-PoP pays the miss; subsequent users at that PoP HIT the edge
until the next run swap purges it.

## Observability

Response headers on `.om` responses carry enough telemetry to diagnose any
tier in the stack. (Note: on an edge HIT our Pages Function doesn't run —
the only authoritative header is `CF-Cache-Status`; everything else is
replayed from the originally-cached response.)

| Header | Who sets | Meaning |
|---|---|---|
| `CF-Cache-Status: HIT` | CF edge (authoritative) | Served from this PoP's edge cache. Function didn't run. |
| `CF-Cache-Status: MISS` | CF edge (authoritative) | Edge didn't have it; function ran. |
| `CF-Cache-Status: DYNAMIC` | CF edge (authoritative) | URL wasn't eligible for cache — rule didn't match. Flag for investigation. |
| `Age: N` | CF edge | Seconds since the cached entry was populated. |
| `X-Surfr-Cache-Status: HIT-R2` | Pages Function | Served from R2. |
| `X-Surfr-Cache-Status: HIT-ORIGIN-EDGE` | Pages Function | Function's origin fetch came back from CF's edge cache of the upstream URL (fast). |
| `X-Surfr-Cache-Status: MISS-ORIGIN` | Pages Function | Origin round-trip; R2 was cold too. |
| `X-Surfr-Upstream-Ms` | Pages Function | Time spent on the origin fetch, if any. |

Debug URLs:
- `/tiles/_admin` — HTML dashboard.
- `/tiles/_debug/cache` — JSON inventory.
- `/tiles/_debug/cache?prefix=data_spatial/dwd_icon_eu/` — filter.

## Capacity and cost

- CF Pages: free tier. Workers Paid ($5/mo) required for the subrequest
  budget that `warmDomain` uses during a fresh run warm.
- R2: `surfr-tile-cache`, location hint ENAM, no jurisdiction. All warmer
  traffic (cron → Pages Function → R2 → Worker) is internal to CF →
  **zero R2 egress fees**. Client traffic never reads R2 directly — always
  via the Pages Function, which is CF-internal from R2's perspective.
- CF cron: 288 ticks/day × 14 domain HTTP calls = ~4 k requests/day.
- Cache purges: ~30 URLs/call on Free plan. Worst-case 14 domains ×
  ceil(72/30) = 42 purge calls per ~5-min tick during a busy window.

Model run cadences and approximate warm volumes (one swap per run):

| Domain family | New run | Warm volume/swap |
|---|---|---|
| NCEP HRRR CONUS | hourly | ~1 GB internal |
| NCEP GFS 0.13/0.25 | 4×/day | ~5 GB internal |
| DWD ICON family | 4×/day | ~3 GB internal |
| ECMWF IFS 0.25 | 4×/day | ~3 GB internal |
| MetOffice, Météo-France, MetNo, KNMI, CMC | 2–8×/day | ~1 GB internal |

All internal traffic, all free.

## Consequences

Positive:
- Repeat scrubs in the same region are edge-served, sub-100 ms TTFB.
- Stale data is impossible: cron purges globally on every swap, `latest.json`
  is R2-only and never cached.
- Each run has an immutable URL → browsers can cache `.om` bytes forever
  with no revalidation, `Range` requests always return 206.
- Tabs left open across a run swap keep working (2 prior runs retained).
- One code base, one deploy pipeline, one R2 bucket, two CF projects
  (Pages + Worker).

Negative:
- First user per PoP pays a one-time MISS cost per URL.
- Outside-horizon requests fall through to origin; small tail latency hit
  for rare scrubs past +72 h.
- Architecture has three moving parts (Pages Function, cron Worker, zone
  Cache Rule). A Cache Rule misconfiguration silently reverts the system
  to "every request is DYNAMIC".

## References

- `functions/tiles/[[path]].ts` — tile proxy, R2 tier, origin fallback.
- `functions/tiles/_warmer-trigger.ts` — HTTP entry for the warmer.
- `functions/tiles/_admin.ts` — HTML dashboard.
- `functions/lib/warmer.ts` — per-domain warm logic, atomic swap,
  retention pruning.
- `functions/lib/domains.ts` — the 14 warmed domain names.
- `worker-cron/src/index.ts` — cron scheduler + force endpoint.
- `worker-cron/src/purge.ts` — CF API cache purge client, canonical URL
  builder.
- `src/lib/url.ts` — client URL builder (runPath included).
- `src/lib/metadata.ts` — `latest.json` fetch + metadata derivation.
- `src/lib/pop-warm.ts` — per-session PoP warm.
- `src/lib/stores/om-protocol-settings.ts` — prefetch with `AbortController`.
- `src/lib/components/run-date-label.svelte` — run-date label widget.
- CF dashboard: Zone `thesurfr.app` → Caching → Cache Rules → `cache-om-tiles`.
- CF dashboard: Pages project `maps` → Settings → Functions → R2 bindings
  → `TILE_CACHE = surfr-tile-cache`.
- CF dashboard: Worker `surfr-tile-warmer-cron` → Settings → Variables →
  `CF_ZONE_ID`, secret `CF_PURGE_TOKEN`.
