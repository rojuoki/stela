# STELA IO — product architecture and implementation plan

**Status:** approved planning baseline for the next build phase.  
**Scope:** turn the independent IO prototype into a user-aware product while
keeping the existing STELA application and its database untouched.

## 1. Decision

The new product will copy the old STELA structure where it is sound:

- authenticated user → per-account unlock entitlement;
- a shared account cache, separate from what any one user may view;
- cache-only grant versus acquisition job as explicit alternatives;
- asynchronous jobs, progress polling, checkpoint/resume, and a single
  authoritative success write;
- a held credit captured only when a successful job advances access;
- normal view versus just-unlocked result range as separate response modes.

The new product will **not** share tables, users, cookies, or credits with the
old STELA. It gets a dedicated database and configuration. Reuse is at the
code-and-contract level, not by writing into the existing database.

The key replacement is the acquisition continuation rule. The old version
continued from the newest cached timestamp. IO must instead continue from the
oldest-side **continuous resolved coverage frontier**. Cached post count and a
latest timestamp are not enough once arbitrary date-range collection exists.

## 2. End-state architecture

```
Browser
  └─ Authenticated STELA IO user
       ├─ prefix unlock: earliest N posts
       └─ date-range unlock: requested [start_at, end_at)

Next.js IO API
  ├─ Access planner: cache-only grant or acquisition job
  ├─ Job queue / polling API
  └─ Result API: only data granted to that user

Dedicated STELA IO PostgreSQL database
  ├─ shared account/posts/coverage cache
  ├─ runs/checkpoints
  ├─ users/unlocks/range unlocks
  └─ credits/holds/events (introduced after access flow is proven)

Provider worker
  └─ TwitterAPI.io or twscrape → result/progress JSON → importer → database
```

During the transition, `data/stela-io.sqlite` remains a local prototype cache
and fixture source. It is not the production source of truth after the new
database path is enabled. The worker still communicates through atomic progress
and final-result files; Node owns all product, access, and billing writes.

## 3. Core domain rules

### 3.1 Shared cache versus user access

`posts` and `coverage_windows` belong to an account and are shared. A user does
not automatically see every cached post.

For earliest-side collection, `user_unlocks.boundary_end` is the number of
chronologically first, covered posts that the user can view. The first product
block and each extension use `PREFIX_BLOCK_SIZE = 1000` initially. The engine
accepts any positive target count; the UI does not expose arbitrary sizes yet.

For a date range, integer boundaries are not meaningful. The separate
`user_range_unlocks` entitlement grants a half-open UTC interval
`[start_at, end_at)`. A successful range request may be fulfilled entirely from
cache without a provider request.

### 3.2 Coverage is the source of acquisition truth

- Only `complete` / `RESOLVED` windows establish reusable coverage.
- `partial` and `unknown` windows never authorize a cache-only grant.
- Split-parent pages are diagnostics only. Their posts are not granted and do
  not establish coverage.
- Posts are surfaced only when `coverage_state = covered`.
- The prefix frontier is the largest uninterrupted union of complete windows
  beginning at account creation. The count used for prefix planning is the
  number of covered posts at or before that frontier, never `COUNT(posts)`.

### 3.3 Atomic success rule

A terminal successful importer transaction must:

1. promote only resolved posts and write coverage windows;
2. recompute the account frontier and available covered prefix count;
3. calculate the requester’s final entitlement;
4. advance the entitlement only when it increases;
5. capture a held credit only when entitlement increased.

An extension is also terminal when the proven prefix reaches the account's
current end before the requested block size. For example, `1000 → +1000` with
only 237 further covered posts settles at `1237`, records a partial result, and
returns the exact `1001..1237` delta. It must never invent entitlement up to
2000, nor discard those 237 proven posts merely because the block was short.

Failures, budget stops that did not reach a resolved success state, and unknown
coverage never advance access or capture a credit.

## 4. Database design

Use a dedicated `STELA_IO_DATABASE_URL` pointing at a new Postgres database (or
an isolated schema in a new environment). The old `DATABASE_URL` and its tables
remain read/write untouched.

| Area | New IO table(s) | Old-version model reused | IO-specific change |
| --- | --- | --- | --- |
| Accounts and posts | `accounts`, `posts` | account cache / tweets | provider, media, mentions, and coverage state retained |
| Proven time coverage | `coverage_windows` | new in IO | account + provider + interval + resolution evidence |
| Execution | `acquisition_runs` | `jobs` | mode, requested range, prefix boundaries, provider metrics, checkpoint JSON |
| Prefix access | `user_unlocks` | `unlocks` | one row per `(user_id, account_id)`, monotonic `boundary_end` |
| Date-range access | `user_range_unlocks` | minimal new table | one entitlement per user/account/normalized interval |
| Auth | `users` | old JWT/password model | own cookie name and own auth secret |
| Billing later | `subscriptions`, `credits`, `credit_holds`, `credit_events` | copy old tables/flow | do not enable until the acquisition/access flow is stable |
| Guest flow later | `temporary_unlocks`, `checkout_sessions` | copy old tables/flow | deferred; authenticated flow comes first |

Important indexes:

- `posts(account_id, created_at, post_id)` for deterministic rank/range reads;
- `coverage_windows(account_id, provider, status, start_at, end_at)` for
  frontier and interval subtraction;
- `acquisition_runs(status, created_at)` and partial unique active-job indexes;
- `user_unlocks(user_id, account_id)` unique;
- `user_range_unlocks(user_id, account_id, start_at, end_at)` unique.

`acquisition_runs` needs these fields beyond the current prototype table:

- `requested_by_user_id`, `mode` (`prefix_initial`, `prefix_extend`,
  `date_range`), `provider`;
- `base_boundary`, `target_boundary`, `granted_boundary` for prefix work;
- `requested_start_at`, `requested_end_at` for range work;
- `checkpoint_json`, `result_json`, `estimated_cost_usd`, and error code;
- `progress_*` counters, output path only as local worker diagnostics.

The run is historical evidence. It must not itself be treated as a user’s
entitlement. `user_unlocks` and `user_range_unlocks` are the access source of
truth.

## 5. API and UI contracts

### Prefix unlock and +1000 extension

`POST /api/io/unlocks/prefix`

- initial request: target is 1000;
- extension request: target is caller’s current boundary + 1000;
- planner returns `cache_only` or `acquisition`;
- cache-only path advances the user boundary in one transaction and returns
  only the newly granted rank range;
- acquisition path creates a run and returns its id for polling.

`GET /api/io/runs/:id` returns status, mode, progress, cost/request metrics,
base/target/final boundaries, and a safe user-visible message.

`GET /api/io/accounts/:username/posts?view=prefix` returns posts `1..boundary`.
`view=delta&runId=…` returns only the newly granted range after verifying that
the run belongs to the requesting user. Rank requests always filter to covered
posts and use deterministic `created_at, post_id` ordering.

### Date-range unlock

`POST /api/io/unlocks/range` accepts a start and end date/time, normalizes them
to UTC, validates `start < end`, and applies product caps. The first product
surface caps a request at 31 days; larger periods are intentionally split by
the caller rather than becoming an unbounded acquisition. It first subtracts
complete cached intervals. It returns an immediate cache-only success when no
gaps remain, otherwise a date-range run.

`GET /api/io/accounts/:username/posts?view=range&startAt=…&endAt=…` verifies a
matching range entitlement before returning covered posts in that interval.

### Authentication and ownership

Copy the old JWT/password flow, but use:

- `stela-io-auth-token` cookie;
- `STELA_IO_AUTH_SECRET` rather than the existing fallback secret;
- a dedicated IO `users` table/database;
- authenticated ownership for every unlock, range entitlement, and run.

There is no anonymous bypass in the production IO routes. A seeded local dev
user may be used behind a development-only flag.

## 6. Engine work

The existing TwitterAPI.io runner already contains the right primitives:
bounded cursor pagination, adaptive windows, dense split, parent discard,
checkpoint restore, and progress snapshots. Extend it with one shared
`RangeExperiment` rather than adding a second ad-hoc script.

Inputs to that experiment:

- `collect_start`, `collect_end` as a half-open UTC window;
- `target_new_count` for prefix extension, optional for date range;
- provider budgets and snapshot end;
- checkpoint state containing the interval queue, candidate ids, counters, and
the immutable request contract.

Modes:

- `prefix_initial`: account creation → snapshot end; stop at target boundary;
- `prefix_extend`: existing continuous frontier → snapshot end; stop after the
  missing portion of the next +1000 block;
- `date_range`: requested interval only; resolve every requested subinterval or
  end at an explicit safe budget state.

For `prefix_extend`, the start must be the stored coverage frontier, not the
timestamp of any particular post. A half-open boundary prevents overlap and
same-second gaps. The importer calculates the final rank/boundary after merging
the worker’s result with existing covered posts.

## 7. Delivery phases

### Phase A — freeze the IO contract and establish the product database

1. Add an IO Postgres schema and migration runner; do not alter legacy tables.
2. Introduce an IO repository interface matching the old repository concepts.
3. Import a disposable copy of existing local IO account/post/run data for
   development verification.
4. Keep current SQLite read paths behind a development switch until parity
   tests pass.

Exit: IO account, posts, coverage, and runs can be read from the new database;
the old application’s database is untouched.

### Phase B — make prefix boundaries first-class

1. Add `user_unlocks` and an IO-only local dev user.
2. Implement prefix rank queries, `upsertUnlockBoundary`, and the planner.
3. Backfill existing successful `target_1000` runs to a development boundary of
   1000, without exposing extra candidates.
4. Change the IO page to show only `covered` posts within the active boundary.

Exit: a cache-only prefix grant and normal `1..N` view work without any provider
call.

### Phase C — ship efficient +1000

1. Add `prefix_extend` run fields, planner, and active-run uniqueness per
   account.
2. Add `RangeExperiment` / collect-start support to the Python engine.
3. Persist and import frontier-safe checkpoints and progress snapshots.
4. On success, atomically merge coverage, compute final boundary, and return
   the delta rank range.
5. Add the explicit `+1000` UI confirmation, progress state, delta view, and
   full-view return action.

Exit: extending an account from 1000 to 2000 does not refetch the resolved
oldest prefix, and a partial final timeline grants only the actual added count.

### Phase D — authentication and user-facing ownership

1. Copy the old signup/login/logout/me routes into IO namespaces with the
   separate cookie and secret.
2. Require an authenticated user for prefix API access and run polling.
3. Add My Unlocks from `user_unlocks`, not from cached account totals.
4. Remove the development-user bypass outside local development.

Exit: two users can unlock the same cached account while seeing only their own
boundaries and runs.

### Phase E — date-range acquisition

1. Add `user_range_unlocks`, UTC validation, a duration cap, and
   interval-subtraction planner.
2. Run gaps through the same `RangeExperiment` and coverage importer.
3. Add range result reads, progress, error states, and range-specific UI.
4. Reuse cache-only intervals with no provider request.

Exit: overlapping ranges reuse proven coverage; incomplete coverage is never
misrepresented as complete.

### Phase F — billing, subscription, and guest flow

1. Copy old credits, holds, events, subscription, and Stripe webhook concepts
   into the dedicated IO database.
2. Wrap plan → credit hold → job → entitlement → capture/release in clear
   transactions and idempotency keys.
3. Add guest temporary results and transfer-on-signup only after authenticated
   flows are stable.

Exit: credits are captured only when access increased; cache-only successful
grants still count as successful unlocks.

### Phase G — operational hardening and cutover

1. Replace in-process single-worker state with a restart-safe queue worker.
2. Retain one-account-at-a-time locking initially; add provider-aware bounded
   concurrency only after shared rate limiting is verified.
3. Add data retention, worker result cleanup, structured logs, health checks,
   metrics, and backup/restore runbooks.
4. Remove the SQLite product read/write path after a verified cutover; retain
   it only for local fixtures if useful.

Implementation decision: the worker claims one Postgres run with a renewable
lease. It never changes the acquisition engine's window/page/split policy to
fit an interactive tool timeout; checkpoint/resume is the only interruption
mechanism. Normal product jobs have no implicit request-count or estimated-cost
stop: an operator may supply an explicit emergency guardrail, but long-running
work is expected to continue through the persistent worker.

## 8. Required test matrix

- first prefix unlock: empty cache, cached prefix, protected account, no posts;
- extension: cache-only, needs exactly 1000, fewer than 1000 remain, dense
  split, same-timestamp boundary, overlapping active requests, checkpoint resume;
- coverage: partial/unknown never satisfy cache, split-parent posts never leak,
  candidate posts never appear in normal view;
- access: two users with different boundaries, delta cannot exceed entitlement,
  range cannot reveal prefix or another range;
- billing later: duplicate submits, expired hold, worker crash, successful
  cache-only grant, successful acquisition, failed acquisition;
- migration: old STELA database receives no writes, IO SQLite-to-Postgres import
  is idempotent, rollback preserves the SQLite prototype.

## 9. Deliberately deferred

- sharing accounts, sessions, credits, or Stripe records with the old product;
- automatic provider fallback;
- arbitrary user-selected prefix sizes;
- distributed or provider-limit-seeking concurrency beyond the initial eight
  local worker slots;
- full timeline claims or exhaustive collection;
- guest payment flow before authenticated prefix and range access are correct.

## 10. Immediate next implementation slice

Start Phase A and Phase B together, then ship Phase C before date ranges:

1. dedicated IO Postgres schema plus repository;
2. `user_unlocks` / monotonic prefix boundary;
3. covered-only deterministic rank reads;
4. continuous coverage-frontier calculation;
5. `prefix_extend` planner and runner mode;
6. `+1000` confirmation, progress, delta result.

This preserves the old product’s core behaviour while making the one important
IO correction: all acquisition decisions depend on proven time coverage, not
on the incidental set of cached posts.
