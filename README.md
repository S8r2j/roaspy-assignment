# Bulk URL Health Checker

A dashboard where a user submits a batch of URLs; a background worker checks each one
(final HTTP status, response time, page title) and the UI reflects progress live as
results arrive.

## Run it

```
docker compose up --build
```

That's the whole command. It brings up Postgres, Redis, the Fastify API, the BullMQ
worker, and the Next.js web app. Migrations run automatically as part of the API
container's startup (`npm run migrate up && tsx src/server.ts`), so a clean checkout
needs no manual DB setup step.

- Web UI: http://localhost:3000
- API: http://localhost:3001

To exercise multi-worker-process correctness (the queue's rate limit/concurrency must
hold regardless of worker count):

```
docker compose up --build --scale worker=2
```

## Architecture

```
                         ┌───────────────┐
  Browser ── HTTP ──────▶│  Fastify API  │──────▶ Postgres (source of truth)
  Browser ◀── SSE ───────│  (N instances)│──────▶ Redis (pub/sub for SSE fan-out,
                         └───────────────┘                BullMQ queue/limiter)
                                                              │
                                                              ▼
                                                    ┌────────────────────┐
                                                    │  BullMQ Worker(s)  │
                                                    │  (separate process)│
                                                    └────────────────────┘
                                                              │
                                                     HTTP GET to target URL,
                                                     writes result → Postgres,
                                                     publishes event → Redis
```

**Postgres is the single source of truth** for batch and job state. Batch progress is
always a live `COUNT(*) ... GROUP BY status` query against the `urls` table — never a
separately maintained counter, which would be a second source of truth that can drift.
Nothing about correctness (progress, final status, cancel/retry) depends on Redis or
BullMQ state surviving; those are transport/queueing conveniences layered on top.

**Redis serves two independent purposes:**
1. BullMQ's backing store for the job queue, worker concurrency, and the global rate
   limiter.
2. A pub/sub channel per batch (`batch:<id>:events`) that any API instance subscribes to
   on behalf of a connected SSE client, so live updates reach the browser regardless of
   which API instance is serving it or which worker processed the job.

**The BullMQ worker runs as its own process** (`apps/worker`), never inside the API
process — required by the spec, and also what makes horizontal scaling of the API safe:
scaling or restarting API instances never touches in-flight checks.

### Data model

```
batches(id, status, created_at)
urls(id, batch_id, url, status, http_status, response_ms, page_title, error, attempt, job_id, updated_at)
```

`urls.status` is one of `queued | running | succeeded | failed | cancelled`. A non-2xx
HTTP response (404, 500, etc.) is a **successful check** with that status code recorded —
only network errors/timeouts are treated as failures subject to retry.

**`batches.status` display note:** `batches.status` flips to `running` the instant a batch
is created, before any worker has picked up a single one of its jobs — it means "not
finished yet," not "actively being worked on right now." Because batches share one fixed
worker pool and the same global rate limit, processed roughly FIFO by submission order, a
second batch submitted while a large first batch is still running can sit at `status:
running` with 100% of its own URLs still queued behind the first batch's jobs. Showing
"Running" for that case reads as broken (a batch doing visibly nothing), so the UI
downgrades the *displayed* badge (not the underlying database value) to "Queued" whenever
every one of a batch's URLs is still in the `queued` state — flipping to "Running" the
instant the first one actually starts.

### Job model: one BullMQ job per URL

Submitting 1,000 URLs creates 1,000 *jobs* in a single Redis-backed queue — it does
**not** create 1,000 worker processes. The number of worker processes is small and fixed
(e.g. 1–2, scaled via `docker compose --scale worker=N`), started once and staying up for
the life of the system. Each process pulls jobs off the shared queue with
`concurrency: 5`, so the queue absorbs arbitrary burst volume against that fixed pool.
Running multiple worker processes exists to satisfy the spec's requirement that
guarantees "must still hold if more than one worker process is running," not as a
throughput/CPU-parallelism mechanism — the workload is network I/O bound (waiting on
HTTP responses), so the 10 req/s global limiter is the actual throughput ceiling
regardless of process count or CPU cores.

No BullMQ "flows" — batch progress is derived from Postgres, so flow-based aggregation
inside BullMQ would just be a second, redundant source of truth.

## Retry and idempotency strategy

- **Global rate limit (10 req/s):** enforced via BullMQ's queue-level `limiter: { max: 10,
  duration: 1000 }`, backed by Redis. This is what makes it *global* across worker
  processes with no extra infrastructure — the limiter state lives in Redis, not in any
  one process's memory. Verified empirically: with 2 worker processes running, job starts
  cluster at exactly 10/second combined, not 10/second/process.
- **Concurrency (5 in flight):** the BullMQ `Worker`'s `concurrency: 5` option, per
  process.
- **Retries (3 attempts, exponential backoff):** set via `attempts: 3` and
  `backoff: { type: 'exponential', delay: 1000 }` on the queue's default job options.
  Only network/timeout errors throw (triggering a retry) — a well-formed HTTP response,
  even a 4xx/5xx, is a final, non-retried result.
- **Idempotency:** each URL's BullMQ job ID is set deterministically to the URL row's
  Postgres UUID (`jobId = urls.id`). Combined with the worker's DB write being an
  **upsert-by-primary-key** (`UPDATE urls ... WHERE id = $1`), redelivery of the same job
  (e.g. after a stalled-job requeue) safely overwrites rather than double-applies.
  One consequence we hit and fixed during development: BullMQ's `.add()` with a `jobId`
  that already exists in a *terminal* state (failed/completed) silently returns the
  stale job rather than creating a new one — so "retry failed" would otherwise be a
  silent no-op. The fix: before re-enqueueing, the API removes any existing job for that
  ID that's already in a terminal state, so retry-failed always produces a fresh run.
- **Cancel vs. in-flight jobs:** cancelling a batch (a) removes any BullMQ jobs still
  `waiting`/`delayed` so they never run, and (b) marks the batch `cancelled` in Postgres.
  A job whose HTTP request is already in flight checks the batch's status again
  immediately after the request resolves, before writing its result — if cancelled, it
  writes `cancelled` instead of overwriting with a stale success/failure. This was
  verified under load: cancelling a batch with several multi-second in-flight requests
  left all of them in `cancelled` state, not overwritten by their late-arriving responses.
- **Cancel is final by design.** "Retry failed only" re-queues rows with `status =
  'failed'` only — it deliberately does not touch `cancelled` rows, so a cancelled batch's
  abandoned URLs stay abandoned; there's no "resume" action. This matches the spec's two
  named controls (cancel, retry-failed) rather than adding a third. A cancelled batch's
  progress line reflects this: it shows URLs actually *checked* (succeeded + failed) out
  of total, not "checked + cancelled" — a batch stopped 5% of the way through reads as
  "50/1000 checked before cancelling (5%)," not a misleading "1000/1000 (100%)."

## Live update transport: SSE

Chosen over WebSockets and polling:
- The data flow here is one-directional (server → client), so SSE's simpler HTTP-based
  model is a better fit than a full-duplex WebSocket.
- `EventSource` auto-reconnects on a dropped connection with no client code required.
- Implemented **non-blocking**: each SSE connection subscribes to a Redis pub/sub channel
  and writes to the response as messages arrive via async event handlers — there's no
  polling loop or busy-wait per connection that would block the Fastify event loop.
- **Multi-instance correctness:** because fan-out goes through Redis pub/sub rather than
  in-process state, it doesn't matter which API instance enqueued the batch, which worker
  processed a job, or which API instance the browser's SSE connection lands on — any
  instance can relay events for any batch.
- **Dropped-connection recovery:** SSE itself has no gap-fill/replay — if the connection
  drops and reconnects, any events published during the gap are lost. To handle this, the
  client re-fetches full batch state (`GET /batches/:id`) on every `EventSource.onopen`
  after the first (i.e. on every reconnect), reconciling any missed updates before
  resuming the live stream.
- **Refresh-safe / cold load:** the batch detail page is a Next.js Server Component that
  always fetches full current state from Postgres server-side before the client-side SSE
  connection opens — so a browser reload, or a cold open of the batch URL in a fresh tab
  with no prior client state, is always correct, whether the batch is still running or
  already finished.
- **Skipped for already-finished batches:** the detail page never opens an SSE connection
  for a batch that's already `done`/`cancelled` on load — it can't change on its own, so
  holding a live connection + 15s heartbeat open for it is pure waste. The one action that
  *can* revive a finished batch (`retry-failed`) explicitly reopens the connection at that
  point instead of speculating up front.

### Real bugs found and fixed here during development

Two were only caught by actually load-testing the live-update path, not by reading the
code:

- **Server: `reply.raw.writeHead()` doesn't guarantee the headers hit the wire.** Node can
  buffer them, so an SSE connection to a batch that wasn't actively emitting events at that
  exact instant would silently hang with zero bytes sent — no error, just a stalled
  connection, until the first real event (which might be seconds or minutes away) or a
  proxy timeout. Fixed with an explicit `reply.raw.flushHeaders()` plus writing an
  immediate `: connected` comment, so `EventSource.onopen` fires right away instead of
  waiting on an arbitrary future event.
- **Client: the first SSE connection skipped reconciliation.** The original logic only
  re-fetched full state (`reconcile()`) on *reconnect after a drop*, on the assumption the
  server-rendered initial snapshot was still fresh. But there's a real gap between that SSR
  fetch and the moment the client's `EventSource` actually finishes its handshake and
  subscribes — any events published in that window were silently lost. Fixed by
  reconciling on every `onopen`, including the first.
- **Server: the SSE route's manual CORS headers.** This route writes directly to
  `reply.raw` and never goes through Fastify's `reply.send()`, so the `@fastify/cors`
  plugin's hooks never ran for it — the browser rejected the connection with a CORS error
  even though every other endpoint worked. Fixed by setting
  `Access-Control-Allow-Origin` explicitly in the raw `writeHead()` call for this one route.
- **Worker: the `running` transition never published an event.** Every other state
  transition (`cancelled`, `succeeded`, `failed`) published a `url.updated` event after
  writing to Postgres; the `running` write was missing that call. The state was correctly
  persisted, but the live UI almost always jumped straight from "queued" to a terminal
  state visually, because the one event that would show "in progress" never fired.
- **Client: aggregate progress (batch detail page) had no live data source after
  pagination was added.** `url.updated` events only patched a row if it was already
  present in the currently-loaded page of `batch.urls`; for a 1,000-URL batch showing 25
  rows, most events matched nothing and were dropped. `batch.updated` (which carries the
  aggregate counts) is only published once, at final completion — so the progress
  bar/stat pills had nothing updating them for the whole run. Fixed by tracking a per-URL
  status map (independent of which page is loaded) so every `url.updated` event
  correctly moves one count from its old bucket to its new one, matching the approach the
  batch list page already used.

## Pagination

Two independent, unrelated paginations exist in this system — worth being explicit about
which is which:

**Batch list** (`GET /batches`): **keyset (cursor-based)**, not offset/limit — chosen
because offset/limit degrades as the table grows (Postgres still scans past skipped rows)
and is prone to skipped/duplicated rows when batches are actively being created/updated
concurrently with someone paging through the list, which is exactly this system's normal
operating condition. Keyset pagination (`WHERE (created_at, id) < (...) ORDER BY
created_at DESC, id DESC`, backed by a composite index) is stable under concurrent
inserts and stays fast regardless of page depth.

**URLs within a single batch** (`GET /batches/:id`, `GET /batches/:id/urls`): also keyset,
25 rows per page, ordered by `id` (not `updated_at`, which changes constantly as jobs
complete — an ordering key has to stay stable under the rows while a client pages through
them). This exists because an early version returned every URL row in one response; on a
1,000-URL batch that was a ~285KB payload fetched in full on every page load *and* every
SSE reconcile. `GET /batches/:id` now returns only the first page (with `urlsNextCursor`);
the client's "Load more URLs" button fetches subsequent pages from
`GET /batches/:id/urls?urlsCursor=...`. The progress bar, stat pills, and settled count
are driven by `batch.counts` (the true aggregate across the whole batch, from Postgres),
not `batch.urls.length` — so they stay accurate regardless of how many pages of the table
are currently loaded.

## Caching (30s, `GET /batches`)

The list response is cached in Redis for 30 seconds, keyed on `(cursor, limit)`. To avoid
the "must not go stale in a user-visible way" trap, **batch creation and any batch
terminal-state transition actively bust the cache** rather than waiting out the TTL — so
the 30s window only bounds staleness for updates that don't matter for this endpoint
(in-flight progress counts on the list view), never for a batch appearing or finishing.
Verified: creating a batch immediately flips a subsequent list request from cache hit to
cache miss.

Separately, Next.js's own client-side Router Cache can serve a stale render of the list
page after a `<Link>`-based soft navigation, independent of the API's cache — this bit us
during development (a newly created batch wasn't visible after navigating back to the
list without a hard refresh). Fixed by marking the list route `force-dynamic` and using
plain `<a>` tags (not `next/link`) for navigation back to it, so every return to the list
is a full re-fetch.

## Type safety

`packages/shared` holds Zod schemas and inferred TypeScript types for the batch/URL
domain model, all API request/response shapes, the SSE event payloads, and the BullMQ job
data shape. It's imported directly by `apps/api`, `apps/worker`, and `apps/web` — there is
one definition of each shape, not parallel hand-maintained interfaces on each side of the
client/server boundary.

## Horizontal scaling behavior

**API scaled to N instances:** safe. Postgres is the only source of truth for batch/job
state, so any instance answering `GET /batches/:id` returns the same correct data. SSE
fan-out goes through Redis pub/sub, not in-process state, so a client connected to
instance A correctly receives events for jobs processed by any worker and published via
any instance. The list cache lives in Redis (not per-instance memory), so cache
hit/miss/invalidation behavior is consistent no matter which instance handles a given
request.

**Worker scaled to N processes:** safe by design and empirically verified (see Retry and
idempotency strategy above) — the rate limiter and job queue are Redis-backed, so 10
req/s and concurrency-5-per-process hold regardless of how many worker processes are
running.

## Trade-offs made under time pressure / what I'd do differently

- **`apps/web` runs via `next dev` inside its container**, not a production build
  (`next build && next start`). This keeps iteration fast for a 3-day project; for a real
  deployment this would switch to a production build in the Dockerfile.
- **CSV parsing is minimal**: it takes the first comma-separated cell per line and treats
  it as a URL candidate (with `https://` prepended if no scheme is present), deduping by
  normalized URL. It does not handle quoted commas beyond a simple strip, or a header row
  detection heuristic beyond "if it doesn't parse as a URL, skip it."
  With more time: a proper CSV parser and explicit header-row handling.
- **Page title extraction** streams the response body up to a 1MB cap and stops as soon
  as a `<title>` tag is found via regex, to avoid buffering huge responses. This is not a
  full HTML parser, so unusual markup (e.g. a title split across multiple chunks at an
  awkward boundary within `TextDecoder`'s streaming) could in rare cases miss the title.
  With more time: a streaming HTML tokenizer instead of a regex over accumulated text.
- **Postgres connection pool size**: raised both the API's and worker's `pg.Pool` from the
  default `max: 10` to `20`, after observing the worker's pool briefly spike to 13
  concurrent connections under multi-batch load (5 concurrent jobs × 2–4 queries per job
  lifecycle). Once a pool hits its max, further queries on it queue for a free connection
  rather than erroring — 20 gives real headroom rather than tuning against one observed
  spike.
- **A React hydration bug caused batch pages to feel like they took 10+ seconds to open**
  under load, even though every server-side timing (API response, SSR render) was
  consistently under 100ms when measured directly. Root cause:
  `new Date(...).toLocaleString()` with no arguments formats using the *host machine's*
  locale/timezone — different on the server (the Docker container, UTC) than in the
  browser (local timezone) — so the server-rendered date text and the client's hydration
  pass disagreed. React treats a text mismatch as a hydration error, and in Next dev mode
  recovering from one forces a full re-render of the affected subtree, which is what
  actually produced the visible delay. Fixed with an explicit `{ timeZone: "UTC" }` so
  server and client always render identical text. Lesson: a hydration warning that looks
  cosmetic can hide a real performance cliff in dev mode.
- **Heartbeat-only SSE keep-alive** (a `: heartbeat` comment every 15s) to prevent
  intermediary timeouts; no explicit reconnection backoff tuning beyond what
  `EventSource` does natively.
- **Assumption**: "final HTTP status code" means following redirects and recording the
  status of the last response in the chain (`redirect: "follow"`), not the first
  response's (possibly 3xx) status.
- **Assumption**: a non-2xx/3xx HTTP response (404, 500, etc.) is a valid, successful
  check outcome — not a failure subject to retry. Only network-level errors (DNS failure,
  connection refused, timeout) are treated as transient failures that trigger BullMQ's
  retry/backoff.

## Project structure

```
apps/api      Fastify API — batch CRUD, SSE endpoint, cache, cancel/retry
apps/worker   BullMQ worker — URL checks, rate limit, retries, idempotent writes
apps/web      Next.js UI — batches list, batch detail with live SSE updates
packages/shared  Zod schemas + shared TS types used by all three
```
