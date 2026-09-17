# CURRENT TASK — Only do this now

**When to read:** Start of session or when unsure what to do next. Prefer this + [INDEX](INDEX.md) over reading full spec.

---

## Current direction: independent STELA IO prototype (agreed 2026-09-01)

Build the new TwitterAPI.io-based STELA as an independent lightweight app with
its own local SQLite database. Keep the existing STELA and its database
untouched; reuse only useful UI and excavation ideas.

### Phases to the provisional UI-connected version

1. **IO engine development and measurement**
   - refine the time-window/split/resolution policy
   - use one-page year/month probes with a provisional threshold of 10 posts
   - adapt resolved normal windows through 7 days → 30 days → 120 days →
     year end; keep a dense window's current span
   - use cursor pagination normally, with independent fetch/page budgets
   - review at 10 pages, normally split at 20, and stop at a 30-page ceiling
   - split only dense, capped, or anomalous windows; discard split-parent samples
     and retain candidates only from resolved child windows
   - run a real oldest-1000 collection (first with `jack`)
   - measure requests, elapsed time, duplicates, window behavior, and fields
2. **Independent local SQLite storage**
   - start with `accounts`, `posts`, `acquisition_runs`, and `coverage_windows`
   - retain `provider` and `run_id`; do not add billing/auth/unlock yet
3. **Independent provisional UI**
   - reuse the existing prototype dashboard components
   - show real profile, oldest-first timeline, date range, top posts, basic stats,
     and media where available
4. **Connect acquisition to the UI**
   - username input -> acquisition -> progress -> SQLite -> results display
   - one job at a time is sufficient for this prototype
5. **End-to-end validation**
   - test sparse, normal, dense, media, reply/mention, and cached re-open cases

Phase 1 is explicitly an **engine development/test phase**, not merely a final
test of an already-complete engine. Its exit condition is that the IO engine can
collect a real oldest-side 1000-post block with measured, understandable window
and request behavior. Absolute provider completeness is not claimed; windows
are operationally `RESOLVED`, `PARTIAL`, or `UNKNOWN` with a recorded basis.

### Phase 1 baseline result (2026-09-02)

The independent TwitterAPI.io prototype completed a live oldest-side run for
`jack` with 1,000 unique posts. It found tweet ID `20` first and produced one
continuous operationally resolved prefix from account creation through
2007-03-10. The baseline used 498 requests, returned 3,718 raw post sightings,
performed 163 time splits, retained 1,075 unique candidates, and took 3,601.83
seconds. No cursor diagnostic found an additional post, and no cursor repeat was
observed. One HTTP 525 and two consecutive network failures recovered by retry.

This proves feasibility, but not provider-level completeness. Before Phase 2,
the main tuning targets are the expensive diagnostic request on almost every
resolved leaf, conservative split threshold 10, wide-window re-fetch overhead,
and the lack of an incremental on-disk resume checkpoint. The 500-request test
ceiling was nearly exhausted and is not a suitable production default.

The next prototype revision replaces cursor-diagnostic-only collection with
bounded normal cursor pagination, removes the rolling 30-day window, and keeps
`target_count` separate from a configurable per-window `fetch_limit`.

### Phase 1 bounded-cursor result (2026-09-02)

The revised TwitterAPI.io prototype passed local probe, pagination, anomaly,
cache-separation, split-threshold, and calendar-window mock tests. A live
`jack` oldest-100 run then returned the same oldest/newest boundary as the
time-split baseline using 11 requests, 143 raw sightings, 20 duplicate
sightings, zero splits, and 21.75 seconds.

The subsequent oldest-1000 run returned exactly the same 1,000 post IDs as the
original one-hour baseline. It used 142 requests, returned 1,075 raw sightings,
retained 1,035 unique candidates, observed 40 duplicate sightings, performed
zero time splits, and finished in 292.35 seconds. All 58 collect windows ended
through observed cursor exhaustion; there were no repeated cursors, UNKNOWN
windows, or HTTP errors. The remaining clear inefficiency is that sparse
seven-day windows commonly require an extra terminal cursor page.

For dense windows, the policy stops normal pagination at 20 pages. The parent
window's paginated sample is retained only as a diagnostic event; its posts,
duplicates, and coverage are discarded. Older and newer child windows are
re-fetched and become authoritative only after they resolve. The observed
cursor time progress sizes an oldest-first child window at a 0.6 safety factor;
half split remains the fallback.

Deferred until after the provisional UI connection: users, per-user count
boundaries, true incremental Extend, billing, Neon migration, date-range mode,
automatic provider fallback, providers beyond TwitterAPI.io/twscrape, and
production-grade worker resume.

---

## Current implementation status (2026-09-03)

- Phase 1: bounded-cursor oldest-1000 engine works for the measured `jack` run;
  the newest dense-window split policy still needs a paid live test.
- Phase 2: independent local SQLite implemented with `accounts`, `posts`,
  `acquisition_runs`, and `coverage_windows`. The stored `jack` result contains
  1,035 unique candidates, including oldest post ID `20`.
- Phase 3: independent `/io` UI implemented. It displays real profile data,
  oldest-first posts, keyword filtering, date/engagement chart, top posts,
  statistics, media when present, mention links, and JSON export.
- Phase 4: local one-job TwitterAPI.io runner and polling API implemented. The UI
  asks for confirmation immediately before a paid acquisition. True incremental
  Extend remains deferred because the engine currently starts from the oldest
  boundary on every run.
- Phase 5: typecheck, lint, production build, SQLite import, and local HTTP/API
  rendering passed. No paid acquisition was started during UI validation.
- The provisional UI now has a manual acquisition-provider selector for
  `twitterapi_io` and `twscrape`. Both engines run through the same local job
  path and normalize into the same SQLite tables. Automatic fallback is not
  implemented. A future official-API adapter can be added to the same provider
  registry. `twscrape` requires `STELA_TWSCRAPE_PYTHON` to point at its Python
  environment and optionally uses `STELA_TWSCRAPE_DB` for its account database.

### Checkpoint resume result (2026-09-04)

- Implemented checkpoint restore for the independent TwitterAPI.io runner.
  Existing schema v1 checkpoints are validated and restored; subsequent safe
  boundaries are written as schema v2 with the next collect position and
  cumulative request/cost metrics.
- The saved `nasa` checkpoint restored 296 candidates and resumed at
  `2008-05-15T00:00:00Z` without re-fetching earlier windows.
- The live continuation reached 1,000 unique oldest-side posts through
  `2009-01-22T00:00:00Z` with 147 cumulative requests, 1,051 raw results,
  1,035 candidates, no unknown windows or splits, and an estimated provider
  cost of `$0.1578` under the `$2.00` guardrail.
- Offline fixture validation is available as `npm run io:test:resume`.

### Broad account survey result (2026-09-04)

- Added `npm run io:batch` for bounded multi-account sampling. It samples 50
  oldest-side posts, retries each failure once, and continues to the next
  account after a skip.
- The first 32-account survey produced 29 full 50-post results, one normal
  account-under-target result (`Apple`, 0 posts), and two retry-then-skip
  results (`realDonaldTrump`, 46; `TaylorSwift13`, 45).
- Batch estimated cost was `$0.5351`; combined with the earlier `nasa` run it
  was approximately `$0.6929`. Per-account JSON, checkpoints, logs, and a
  timestamped summary are under `results/twitterapi-io-batch-20260904/`.

### 1000-post efficiency survey result (2026-09-05)

- The 1000-post survey processed 12 accounts before the cost reservation stop.
  Nine completed 1,000 posts: `BarackObama`, `elonmusk`, `sama`, `Google`,
  `Microsoft`, `YouTube`, `Netflix`, `nytimes`, and `CNN`.
- Successful runs recorded 1,887 API requests, 9,496 raw sightings, 9,186
  candidates, 310 duplicate sightings, 900 resolved windows, 19 partial probe
  windows, zero UNKNOWN windows, and zero splits. The successful runs took
  about 66.6 minutes in total and cost an estimated `$1.4260`.
- `BillGates`, `SpaceX`, and `OpenAI` hit a Python read timeout in the first
  runner revision after preserving checkpoints. The runner now retries
  `TimeoutError` with backoff, and batch summaries fall back to checkpoint
  metrics when no final result JSON exists.
- The initial total-cost stop allowed the in-flight account to finish, so it
  exceeded its soft `$1.28` reservation at `$1.4260`. The batch now reserves
  the per-account cap before starting the next account.
- Detailed outputs, checkpoints, logs, and summary are under
  `results/twitterapi-io-1000-survey-20260904/`.

### Year-adaptive / split validation (2026-09-06)

- Replaced the IO runner's monthly promotion policy with normal-window spans of
  7 days → 30 days → 120 days → the next Jan. 1. A resolved window with at
  least 100 posts retains its current span; split children do not alter it.
- The checkpoint schema is now v3 and persists the next normal span. Existing
  v1/v2 checkpoints safely resume at the saved coverage frontier using the
  initial seven-day span when no v3 span is present.
- Fixture validation covers the saved 296-post NASA resume, sparse expansion to
  year end then reset, dense seven-day span retention, and parent-window discard.
- A bounded live three-account run cost an estimated `$0.5302`: `elonmusk` and
  `nytimes` reached 1,000 posts; NASA exercised one 20-page density split and
  discarded 460 parent posts before its `$0.20` per-account limit stopped it at
  868 posts. Results are under `results/twitterapi-io-1000-year-adaptive-20260906/`.
- The default inter-request completion interval is now `0.7s`. A controlled
  `elonmusk` re-run used the same 83 requests, returned the same 1,000 posts,
  cost `$0.1722`, and completed in `171.49s` versus `189.98s` at `1.0s`; no
  HTTP 429 or retry was recorded. Results are under
  `results/twitterapi-io-1000-interval-0p7-20260906-retry/`.
- The IO batch runner now supports account-level concurrency while keeping
  each account's cursor chain serial. Workers share a file-backed provider
  limiter and reserve each account's cost ceiling before launch. A live
  four-account/100-post check with concurrency `4` and a shared `6 req/s`
  ceiling completed three accounts successfully and one at its `$0.04` soft
  cost stop, with `$0.1167` estimated spend and no recorded 429/retry. Results
  are under `results/twitterapi-io-parallel-100-20260906/`.
- Implemented the first UI progress slice: after each atomic checkpoint, the
  IO runner writes a progress snapshot and the Node job imports it while the
  process is still running. The UI refreshes when run counters change and
  shows only covered posts during acquisition, so split-parent candidates are
  not presented as final data. Updates are window-based rather than fixed at
  100 posts. Fixture, typecheck, and production build passed.

### Next work

1. Run one explicitly approved paid acquisition through the UI and verify
   progress/import/error paths end to end.
2. Split-parent discard is aligned with the legacy rule: parent pages are
   diagnostic-only, while only resolved child windows contribute candidates,
   duplicates, and coverage. The fixture verifies that parent posts are removed.
3. Decide whether to implement efficient next-block Extend or production-grade
   worker resume before testing additional accounts and media-heavy timelines.

### +1000 concurrency and settlement hardening (2026-09-16)

- The persistent Postgres worker now runs eight account jobs concurrently and
  refills a slot immediately when one finishes. Database tests cover eight
  simultaneous claims, one-active-acquisition-per-account, refill, and expired
  lease recovery.
- All eight local runners share one provider request-start limiter, configured
  at 6 requests/second by default. The provider limit itself has not been
  stress-tested and remains a later measurement task.
- Cache-only unlocks now use the same queued acquisition screen and worker
  settlement path, while recording zero provider requests and zero estimated
  cost. Shared acquisition/cache reuse is not disclosed in the UI.
- Concurrent users share one real acquisition. Each user's boundary is settled
  independently through a short cache grant after shared coverage becomes
  available.
- Cancellation is persisted, stops a running child at the next heartbeat or
  progress event, and rejects late result imports. Failed, timed-out, canceled,
  zero-post, and partial-final-timeline paths cannot over-advance a boundary.
- An offline eight-run resource test observed eight overlapping child runners,
  at most eight Postgres connections in its first run, about 277 MB peak RSS
  for the worker process tree, and no completed result/checkpoint/progress files
  left behind. These memory figures use a lightweight fake provider runner;
  real eight-account memory still requires a paid live observation.
- Island-block persistence and grant remain part of the later date-range phase,
  not the +1000 completion scope.

### Railway worker preparation (2026-09-17)

- Added worker-only Docker/Railway configuration and operator instructions in
  `docs/IO_RAILWAY_WORKER.md`; no external deployment has been performed.
- Persist actual Python checkpoints in the existing DB column and restore them
  into fresh per-attempt directories. Shutdown stops children before requeuing.
- A direct-Postgres session lock prevents overlapping Railway deployments from
  running two eight-slot coordinators. Web may use a pooled URL separately.
- Fence worker result imports by ownership and recover interrupted prefix grants
  at startup. No additional database table or migration was needed.
- Local fixture integration covers graceful and hard restart, expired leases,
  fresh filesystem recovery, singleton ownership, and late result rejection.
- Docker image build / Railway deployment acceptance, real API resource sizing,
  continuous monitoring, and failed-file retention are not yet verified/completed.
