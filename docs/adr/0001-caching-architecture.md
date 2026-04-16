# ADR 0001 — Tile caching architecture on Cloudflare

- Status: **Accepted — with active Cache Reserve investigation (see Update 2026-04-16)**
- Date: 2026-04-16
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
5. Transparent observability: admin dashboard + response headers that say where
   a byte came from.

## Decision

We run a **four-tier cache stack** on Cloudflare, driven by a scheduled cron
that writes to an R2 bucket and invalidates the CF edge cache on every
upstream run swap. Every `.om` request funnels through a Pages Function at
`maps.thesurfr.app/tiles/*`.

```
Client (browser)
  │
  │ 1. Browser cache             (Cache-Control: public, max-age=30d)
  │     HIT ─► served from disk
  │     MISS
  ▼
CF edge cache at user's PoP      (Cache Rule: .om URLs, Edge TTL 30d)
  │     HIT (CF-Cache-Status: HIT)  ─► ~20-120 ms, no origin touched
  │     MISS
  ▼
Pages Function (our code)
        │
        ├── For latest.json / meta.json ─►  R2 only, or 503. No origin fallback.
        │
        └── For .om:
              1) Read R2 latest.json (in-isolate cache 30 s).
              2) Build canonical path = /data_spatial/<domain>/YYYY/MM/DD/HHmmZ/<validTime>.om
              3) R2.get(canonicalKey[, range])  ─► HIT-R2, return 206/200
              4) R2 MISS ─► fetch(originCanonical, cf.cacheEverything=true)
                            + waitUntil(warmR2())   — lazy R2 fill
                            │
                            ▼
                          Open-Meteo origin  (https://map-tiles.open-meteo.com/...)
```

### Four tiers, three caches

| Tier | Where | TTL | Populated by |
|---|---|---|---|
| T1 | Browser | 30 d (from `Cache-Control: public, max-age=2592000`) | Any HIT response |
| T2 | CF edge (per-PoP, + Smart Tiered Cache upper tier) | 30 d (from the Cache Rule, which **ignores** `Cache-Control`) | First user at each PoP; invalidated globally by cron on run swap |
| T3 | R2 bucket `surfr-tile-cache` (global, ENAM region) | Indefinite (no TTL on R2) | Cron warmer (proactive, 72 h horizon) + Pages Function `waitUntil(warmR2)` lazy fill (files outside the horizon) |
| T4 | Open-Meteo origin | n/a | — |

### Client URL shape — runPath stripping

Clients request **stripped URLs**:

```
GET /tiles/data_spatial/<domain>/<validTime>.om
```

— **no** `YYYY/MM/DD/HHmmZ` run path. The Pages Function fills it in from R2
`latest.json` on every request. Rationale:

- **Stripped URL is stable across runs.** The CF edge cache key includes the
  path, so a stable URL means 30-day cache entries keep working — we just
  purge them on swap (see below).
- **Server is the single source of truth** for "which run is current." Client
  never has to reconcile a stale reference_time it's holding in memory.
- **Race resistance.** Without stripping, clients that had cached the old
  reference_time in their `meta.json` would request old-run paths after a
  swap, miss our cache, and pay an origin round-trip. With stripping the
  request always lands on whatever R2 says is current.

Client code: `src/lib/url.ts:getOMUrl()` and `getNextOmUrls()`.

### JSON indexes — R2 only, 503 on miss

`latest.json` and `meta.json` are served **exclusively from R2**. If R2 has
no object, the Pages Function returns **503 Service Unavailable** with
`Retry-After: 60`. **No origin fallback.**

Reason: falling through to origin would expose a run that upstream has
published but our cron **hasn't finished downloading into R2 yet**. Clients
would then see a `reference_time` whose `.om` files don't exist in R2, pay a
cold origin pull for every range, and generally undo the whole point of
`latest.json` being our own canonical pointer. Strict "only serve a run
once every file for it is in R2" avoids that entire class of bug.

(Note: "cache warming" elsewhere in this doc sometimes refers to CF edge
cache populating at a PoP — a separate concern. This paragraph is specifically
about the R2 side: `latest.json` flips to a new `reference_time` only after
the cron has put all that run's `.om` files into R2.)

Code: `functions/tiles/[[path]].ts:R2_JSON_KEY` + `serveJsonFromR2`.

### The 72 h window and what happens outside it

The cron warmer caps per-domain warming at **72 hours** of forecast horizon
from the run's `reference_time` (`MAX_HORIZON_HOURS` in
`functions/lib/warmer.ts`). Rationale: most users scrub within ±48 h; warming
the full 10-day GFS horizon would balloon R2 writes with low payoff.

**Inside the 72 h window:**
- R2 has the file. Pages Function serves from R2 (HIT-R2 ~100–500 ms).
- After purge-on-swap, first user at a cold PoP pays one R2-read;
  subsequently CF edge HIT (~20–120 ms).

**Outside the 72 h window** (hours 73+, or older run paths if a client ever
sends one):
1. Client request → CF edge MISS → Pages Function.
2. Pages Function reads R2 `latest.json`, builds canonical path, R2.get → MISS.
3. Falls through to `fetch(originCanonical, cf.cacheEverything=true)`. The
   origin response streams back to the client — their specific range is
   served, nothing blocks. If the client asked for a range, origin returns
   a 206 for just that range; if they asked for the full file, a 200.
4. **In parallel, via `waitUntil`**, `warmR2` fires an *independent*
   `fetch(originCanonical)` **with no Range header** and streams that full
   response body into R2 via `TILE_CACHE.put`. Client doesn't wait for this
   — it's background. Once it finishes (a few seconds to tens of seconds
   depending on file size) R2 has the full file.
   (Only fires if R2 head-check confirms nothing is already there, to avoid
   duplicate puts on concurrent misses.)

End state after one user hits an outside-horizon URL at PoP X:
- **CF edge at PoP X has the full file cached** (thanks to `cacheEverything`
  + our Cache Rule). Subsequent range requests to this URL *at PoP X* are
  edge HITs, never reach R2 or origin — same as a cron-warmed in-horizon
  URL.
- **R2 has the full file** (thanks to `warmR2`). A user at a *different* PoP
  Y still incurs an edge MISS at Y on their first hit, but now Pages
  Function's R2 tier HITs instead of falling through to origin — ~400 ms
  R2 read instead of ~1 s origin round-trip. After that first hit, PoP Y's
  edge is warm too and subsequent Y users HIT the edge.

So outside-horizon URLs reach the same steady state as in-horizon URLs
after one user has touched them at each PoP; they just don't get the
cron's global purge-on-swap treatment.

So outside-horizon still works, just with a first-user-pays-origin cost per
PoP (and then per-R2 fill). This is deliberate: we trade a slow first access
on rarely-visited forecast hours for bounded R2 usage.

Caveat: outside-horizon CF edge entries are **not** invalidated by the cron
on run swap (cron only knows about the 72 h validTimes). A user scrubbing to
hour 80 of an old run could see stale data until the 30-day CF TTL expires.
In practice the client's `meta.json` refresh (every 5 min, see
`METADATA_REFRESH_INTERVAL` in `src/lib/constants.ts`) moves the client to
the new run within 5 min, and the client never requests the old-run hour 80
URL again — it asks for the new-run equivalent, which hits a fresh cache path.

### Update flow on a new Open-Meteo run

The cron fires every **5 min** (CF Workers cron trigger
`*/5 * * * *` on `surfr-tile-warmer-cron`). It walks the 14 domains
sequentially, one HTTP call per domain to
`https://maps.thesurfr.app/tiles/_warmer-trigger?domain=<d>&wait=1`.

Inside the Pages Function (`functions/lib/warmer.ts:warmDomain`):

1. Fetch upstream `latest.json`.
2. Compare `reference_time` with R2's `latest.json`.
3. If unchanged → return `{ status: 'unchanged' }` and stop.
4. Otherwise:
   a. Fetch upstream `meta.json` for the new run.
   b. Cap valid_times to +72 h from `reference_time`.
   c. Warm each capped validTime to R2 with concurrency 4 (stop-on-404, skip
      already-in-R2 via `head`, per-domain 4 min deadline).
   d. If any file failed or the run's tail still 404s (model still uploading),
      bail **without** swapping — next tick resumes from where we left off.
   e. **Atomic swap**: put new `meta.json` → R2, then put new `latest.json` →
      R2. Only after both writes do clients see the new run.
   f. Delete old-run `.om` files from R2 (`deleteOldRunFiles`) by listing
      `data_spatial/<domain>/` and dropping keys whose run-path segment ≠ the
      new run.
   g. Return `{ status: 'warmed', referenceTime, validTimes, files: {...} }`.

The cron worker then sees `status: 'warmed'` in the JSON response, pulls out
`validTimes`, builds stripped URLs
(`https://maps.thesurfr.app/tiles/data_spatial/<domain>/<validTime>.om`),
and calls the CF API to purge them (batched 30 URLs per request, the
Free-plan limit). Purge is **global**: CF evicts those URLs from every PoP
simultaneously. No per-PoP re-warm after purge — first user at each cold PoP
will lazily refill the edge from R2 on their first hit (documented
acceptable cost; see "PoPs and edge warming" below).

Code:
- `worker-cron/src/index.ts` — driver, inspects per-domain response, calls
  `purgeDomain`.
- `worker-cron/src/purge.ts` — CF API client.
- Env required on the cron worker: secret `CF_PURGE_TOKEN`
  (Zone: Cache Purge scoped to `thesurfr.app`), plaintext var
  `CF_ZONE_ID = f5f6361a616de5b43d6bc305d452d42c`.

### The Cache Rule (the thing that makes all of the above actually cache)

Pages Function responses default to `CF-Cache-Status: DYNAMIC`, meaning CF
skips the edge cache entirely. **`Cache-Control: public, max-age=…` from the
function is not enough** — CF only caches file types it recognises as static
by default, and `.om` isn't one of them.

The Cache Rule (one-time dashboard setup, zone `thesurfr.app`, Caching →
Cache Rules):

```
name:        cache-om-tiles
expression:  (http.host eq "maps.thesurfr.app"
              and ends_with(http.request.uri.path, ".om"))
cache:       Eligible for cache
edge TTL:    30 days, ignore origin Cache-Control
browser TTL: respect origin (we send max-age=2592000 which matches)
order:       first (before any broader rule)
```

Without this rule, every `.om` hit reaches the Pages Function.

### Admin dashboard

`https://maps.thesurfr.app/tiles/_admin` — HTML page (no auth, read-only),
generated by `functions/tiles/_admin.ts`.

Per domain it shows:
- Status pill: OK (green) / STALE (orange, upstream has newer run) / COLD
  (red, never warmed) / UNKNOWN (grey, upstream unreachable).
- Our R2 `latest.json` `reference_time` + mismatches against `meta.json`
  or upstream.
- Number of `.om` files in R2 for the current run + total MB.
- Oldest / newest validTime in R2.
- "Last tick" — age and status of the most-recent per-domain warm, from
  `_warmer/last-domain-<domain>.json`.

At the top a collapsible "Last cron" details block shows the most recent
`_warmer/last-tick.json` (written on every `warmDomain` completion). There
are also action buttons to trigger the warmer or view the debug inventory.

Related endpoints:
- `/tiles/_warmer-trigger?domain=<d>&wait=1` — run warmer for one domain,
  wait for result.
- `/tiles/_warmer-trigger` — run all domains, fire-and-forget (default used
  by the cron worker).
- `/tiles/_debug/cache` — JSON inventory of R2 keys grouped by prefix.
- `https://surfr-tile-warmer-cron.herbert-0fd.workers.dev/force?domain=<d>`
  — force a CF cache purge for one domain's current run, bypassing the
  "unchanged" short-circuit (used for bootstrap and manual recovery).

## PoPs and edge warming

**PoP** = Cloudflare Point of Presence, a datacenter. CF has ~250+ worldwide;
every user is latency-routed to the closest one. **Edge cache is per-PoP** —
a HIT at PoP A does not benefit PoP B.

**The cron worker runs at one PoP** (wherever CF schedules it). When the
cron fires a purge, the purge is global, so every PoP drops the stale entry.
When the cron *could* re-warm, it only warms its own PoP (and, via Smart
Tiered Cache, the upper tier). We tried the re-warm and found the benefit
marginal for other PoPs — so the current cron is **purge-only, no re-warm**.

How edge cache actually gets warmed at other PoPs:

1. **First user at a cold PoP**: range request → CF edge MISS → Pages
   Function → R2 → 206 response. CF caches the full file (see note below)
   and the range response goes back. ~400–1600 ms.
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
(~70 KB combined) and stop — no data blocks fetched. But from CF's point of
view, that range request against an uncached cacheable URL triggers a full
26 MB fetch + edge cache. Side effect: **by the time the user actually
scrubs to hour T+1, the PoP already has the full T+1 file cached**. Every
range on T+1 is instant.

We cancel the in-flight prefetch via an `AbortController` on every new
`postReadCallback` so fast-scrubbing users don't back up HTTP/2 streams
behind a slow prefetch.

Trade-off: the prefetch itself is slow (~500 ms–1 s, because CF is doing a
full-file origin fetch under the hood) and the user sees that as a visible
green "Waiting" bar in DevTools on every scrub. The browser only needs the
tiny range, but CF uses the prefetch as the opportunity to warm everything.

### Why first-hit latency looks bad in isolation but is benign at scale

When developing alone against a fresh PoP you see the worst-case numbers:

- Every URL is cold at your PoP → every `.om` scrub pays one 400–1600 ms
  MISS before the 30-day edge HIT streak kicks in.
- The prefetch for T+1 is *also* cold and pulls the full T+1 file from R2
  (or origin for outside-horizon), which is the 500 ms–1 s green bar you
  keep seeing in DevTools.

In production the picture changes in two ways:

1. **PoPs get pre-warmed by the population, not by the cron.** Every user
   who lands at a given PoP is effectively a cron-like warmer for the next
   user at that PoP. With ~250 CF PoPs and any meaningful user base (say,
   tens of users per active PoP per day), each PoP's edge is already hot
   on every commonly-scrubbed hour long before a new user arrives. That
   first user at a PoP pays the miss; the next 999 users hit the 30-day
   edge cache.
2. **New runs don't reset all that work.** A run swap purges the 72 h of
   validTime URLs at every PoP globally — so the edge goes cold for those
   URLs again — but the first user at each PoP after the purge is now
   fetching a file that R2 already has (cron warmed R2 before the purge),
   so the miss cost is *R2-read latency* (~400 ms from a far PoP) not
   *Open-Meteo-origin latency* (~1 s + cold-bucket overhead). Subsequent
   users at that PoP are edge-HIT again within seconds.

Net effect in production:
- **p50 TTFB on `.om` ranges**: ~20–120 ms (edge HIT, most traffic).
- **p99 TTFB**: ~400–600 ms (first user at a PoP, freshly-purged URL, R2
  read — sees `X-Surfr-Cache-Status: HIT-R2`, `CF-Cache-Status: MISS`).
- **p99.9 TTFB** (outside-horizon, never-warmed URL): ~1–2 s origin round
  trip.

What the solo developer experience does *not* represent is average user
latency — it represents the cost of being the "first warmer" for every URL
at your PoP. That cost is paid once per (URL, PoP) per 30 days in
production. With N users per PoP, only 1-in-N pays it.

## Update 2026-04-16 — Cache Reserve findings and current PoP-warming mitigation

After the initial deploy we revisited Cache Reserve as a way to eliminate
the per-PoP first-miss cost (the "first warmer" tax called out above).
Cache Reserve, in theory, should behave like a global persistent tier that
sits between per-PoP edge caches and origin — so any PoP's MISS would fall
through to Cache Reserve (global HIT) instead of to our Pages Function
→ R2 path. Combined with our existing cron-driven purge-and-refill loop,
the goal was: one warm pass per run swap → every PoP is effectively hot
from the next request onward.

**What we found:**

1. **Cache Reserve does not catch our traffic.** Despite the `.om` Cache
   Rule being eligible and `CF-Cache-Status` reporting `MISS` at the edge,
   subsequent cold-PoP hits do **not** come back as `HIT` from Cache
   Reserve — they fall straight through to our Pages Function / R2.
   Responses lack the `cf-cache-reserve-*` markers we would expect on a
   reserve HIT. Empirically, Cache Reserve behaves as if it's disabled for
   our zone even with the feature toggled on.
2. **Cron-driven warm probes are not being "caught" by Cache Reserve
   either.** The cron worker's stripped-URL fetches after a run swap
   (intended, in the re-warm version of the design, to populate Cache
   Reserve from one well-connected PoP and thereby warm every downstream
   PoP) do not end up in the reserve. As a result re-warming from the cron
   has no global benefit — it only warms the cron's own PoP, which is
   exactly the trade-off that led us to remove re-warm from the cron in the
   first place.
3. **Support ticket is open with Cloudflare** to determine whether this is
   a plan-gating issue, a zone-configuration issue, or a product limitation
   (e.g. Cache Reserve only engages for specific content types, size
   thresholds, or origin types, and our Pages-Function-fronted R2 traffic
   isn't one of them). Ticket status will be tracked on the internal
   engineering doc; update this ADR once resolved.

**Consequences while the ticket is open:**

- The **cron worker does not re-warm**. It purges globally on run swap and
  stops. There is no point spending internal traffic on probing URLs that
  won't land in a shared tier. This matches the code already committed in
  `worker-cron/src/index.ts` and the "purge-only, no re-warm" line under
  *PoPs and edge warming* above — but the reason is now "Cache Reserve is
  not catching probes" rather than "re-warm only warms the cron's PoP".
  Both are true; the current one is load-bearing.
- **PoP warm-up is therefore a client-side concern.** The
  `postReadCallback` prefetch documented under *The prefetch — per-PoP
  self-warming* (see `src/lib/stores/om-protocol-settings.ts`) is, in
  effect, how PoPs get warm for a given user session today: the user's
  first scrub at a PoP fetches prev/next-hour files in the background,
  which — because CF caches the full file on any range request against a
  cacheable URL — populates that PoP's edge for every adjacent hour the
  user is likely to scrub to next.
- This means **the first user at a cold PoP still pays the MISS cost** on
  the very first `.om` URL they touch. There is no server-side mechanism
  that will warm their PoP before they hit it. Anything else a user scrubs
  to gets pre-warmed by the prefetch they just triggered.
- The **R2 tier remains load-bearing** as the fallback for every cold-PoP
  MISS. Without Cache Reserve catching anything, the path for a cold-PoP
  first request is always: edge MISS → Pages Function → R2 HIT → 206.
  Latency sits in the 400–600 ms band we document in the *Why first-hit
  latency looks bad in isolation* section.

**If / when Cloudflare resolves the ticket** and Cache Reserve starts
catching our probes, the minimal change is to flip the cron worker from
purge-only back to purge + re-warm: after `purgeDomain` completes, fire a
bounded-concurrency `fetch(strippedUrl, { cf: { cacheEverything: true } })`
for each validTime so the next tier above the PoPs is primed. Code
location: `worker-cron/src/index.ts:runTick`, right after the `purgeDomain`
call. The re-warm itself is ~1 GB of internal traffic per domain per swap
and was measured cheap when we had it enabled earlier.

## Observability

Response headers on `.om` responses carry enough telemetry to diagnose any
tier in the stack. (Note: on an edge HIT our Pages Function doesn't run —
the only authoritative header is `CF-Cache-Status`; everything else is
**replayed from the originally-cached response**.)

| Header | Who sets | Meaning |
|---|---|---|
| `CF-Cache-Status: HIT` | CF edge (authoritative) | Served from this PoP's edge cache. Function didn't run. |
| `CF-Cache-Status: MISS` | CF edge (authoritative) | Edge didn't have it; function ran. |
| `CF-Cache-Status: DYNAMIC` | CF edge (authoritative) | URL wasn't eligible for cache — rule didn't match. Flag for investigation. |
| `Age: N` | CF edge | Seconds since the cached entry was populated. |
| `X-Surfr-Cache-Status: HIT-R2` | Pages Function | When the cached entry was first populated, it came from R2. |
| `X-Surfr-Cache-Status: HIT-ORIGIN-EDGE` | Pages Function | Function's origin fetch was itself an edge HIT. |
| `X-Surfr-Cache-Status: MISS-ORIGIN` | Pages Function | Origin round-trip; R2 was cold too. |
| `X-Surfr-Reference-Time` | Pages Function | The `reference_time` the function used to build the canonical path. |
| `X-Surfr-Latest-Ms` | Pages Function | Time spent reading R2 `latest.json` (0 = in-isolate cache HIT). |
| `X-Surfr-Upstream-Ms` | Pages Function | Time spent on the origin fetch, if any. |

Debug URLs:
- `/tiles/_admin` — HTML dashboard.
- `/tiles/_debug/cache` — JSON inventory.
- `/tiles/_debug/cache?prefix=data_spatial/dwd_icon_eu/` — filter.

## Capacity and cost

- CF Pages: free tier. Workers Paid ($5/mo) required for the subrequest
  budget that `warmDomain` uses during a fresh run warm.
- R2: `surfr-tile-cache`, location hint ENAM, no jurisdiction. All warmer
  traffic (cron → Pages Function → R2 → Worker) is internal to CF, which
  means **zero R2 egress fees**. Client traffic never reads R2 directly —
  always via the Pages Function, which is still CF-internal from R2's
  perspective.
- CF cron: 288 ticks/day × 14 domain HTTP calls = ~4 k requests/day —
  comfortably free.
- Cache purges: ~30 URLs/call on Free plan. Worst-case 14 domains ×
  ceil(72/30) = 42 purge calls per ~5-min tick during a busy window.
  Still well under the rate limit.

Model run cadences and approximate warm volumes (one swap per run):

| Domain family | New run | Warm volume/swap |
|---|---|---|
| NCEP HRRR CONUS | hourly | ~1 GB internal |
| NCEP GFS 0.13/0.25 | 4×/day | ~5 GB internal |
| DWD ICON family | 4×/day | ~3 GB internal |
| ECMWF IFS 0.25 | 4×/day | ~3 GB internal |
| MetOffice, Météo-France, MetNo, KNMI, CMC | 2–8×/day | ~1 GB internal |

All internal traffic, all free.

## Future work

- **Cache Reserve / Smart Tiered Cache resolution (blocked on CF support
  ticket).** Smart Tiered Cache is enabled on the zone and Cache Reserve
  was evaluated as the next escalation, but — as documented in the
  *Update 2026-04-16* section above — neither is catching our traffic
  today. Support ticket is open with Cloudflare; when resolved, re-enable
  the cron worker's re-warm step (a pure `fetch(url, { cf: {
  cacheEverything: true } })` per stripped URL after `purgeDomain`) so the
  shared tier is primed on every run swap. Code location:
  `worker-cron/src/index.ts:runTick`. Until the ticket is resolved,
  continue relying on the client-side prefetch for per-PoP warming.
- **Pre-populate PoPs globally.** CF does not expose a primitive to push a
  cache entry into every PoP. If first-user-per-PoP latency proves painful
  after Smart Tiered Cache is ruled out, options include:
  - Running multiple warmer Workers in different regions via explicit
    regional deployments (CF Workers doesn't support this directly;
    requires ≥ 1 Worker invocation per region from an external scheduler).
  - Offering an opt-in "hot mode" endpoint that hits the warmer from the
    client's own PoP on page load (trivially warms that PoP for the
    current viewport only).
  - Accepting the first-miss cost. Our current choice.
- **Purge outside-horizon files on swap.** On run swap, only the 72 h
  validTimes are purged. Stale outside-horizon entries (if any ever got
  cached) linger for 30 days. If this ever matters, purge by domain
  prefix (requires Enterprise) or enumerate the full horizon from the
  new `meta.json`.
- **Rewrite the library's `_iterateDataBlocks`** to parallelise index-
  block reads. Upstream PR rather than a monkey-patch — we tried the
  patch in-repo and reverted it because the effect was dominated by CF
  latency and network RTT, not library waterfalling. Revisit once CF
  tier propagation is confirmed.

## Consequences

Positive:
- Repeat scrubs in the same region are edge-served, sub-100 ms TTFB.
- Stale data is impossible: cron purges globally on every swap, JSON indexes
  come from R2 only.
- Client URLs are stable across runs — no drift when a new run publishes
  while a user is mid-session.
- One code base, one deploy pipeline, one R2 bucket, two CF projects
  (Pages + Worker).

Negative:
- First user per PoP pays a one-time MISS cost per URL. Acceptable.
- Outside-horizon requests fall through to origin; small tail latency hit
  for rare scrubs past +72 h.
- Architecture has three moving parts (Pages Function, cron Worker, dashboard
  Cache Rule). A Cache Rule misconfiguration silently reverts the system to
  "every request is DYNAMIC", which is exactly the failure mode we had on
  initial deploy — documented above so it's diagnosable.

## References

- `functions/tiles/[[path]].ts` — tile proxy, R2 tier, origin fallback.
- `functions/tiles/_warmer-trigger.ts` — HTTP entry for the warmer.
- `functions/tiles/_admin.ts` — HTML dashboard.
- `functions/lib/warmer.ts` — per-domain warm logic, atomic swap, old-run
  cleanup.
- `functions/lib/domains.ts` — the 14 warmed domain names.
- `worker-cron/src/index.ts` — cron scheduler + force endpoint.
- `worker-cron/src/purge.ts` — CF API cache purge client.
- `src/lib/url.ts` — client URL builder (stripped).
- `src/lib/stores/om-protocol-settings.ts` — prefetch with AbortController.
- `src/lib/constants.ts` — block size, metadata refresh cadence.
- CF dashboard: Zone `thesurfr.app` → Caching → Cache Rules → `cache-om-tiles`.
- CF dashboard: Pages project `maps` → Settings → Functions → R2 bindings
  → `TILE_CACHE = surfr-tile-cache`.
- CF dashboard: Worker `surfr-tile-warmer-cron` → Settings → Variables →
  `CF_ZONE_ID`, secret `CF_PURGE_TOKEN`.
