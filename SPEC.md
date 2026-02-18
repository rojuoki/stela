You are building a production-grade product called STELA.

This document is the single source of truth.
Do not reinterpret it.
Do not expand scope beyond the CURRENT TASK.
Follow all NON-NEGOTIABLE RULES.

==================================================
0. PRODUCT CORE
==================================================

STELA lets a user instantly unlock and view the earliest 100 posts
of any public X account without manual scrolling.

This is a viewing product, not an analytics product.

Primary experience:

input username
→ unlock
→ earliest 100 posts appear in a stable X-like layout

The system must be deterministic, fast, and low-cost.

The product is NOT:
- a timeline clone
- a full scraper
- an exhaustive crawler
- an analytics dashboard (for MVP)

==================================================
1. NON-NEGOTIABLE RULES
==================================================

DATA ACQUISITION

1. NEVER perform exhaustive paging from newest to oldest.
2. NEVER crawl entire timelines.
3. Use time-window jump toward the oldest side.
4. Fetch minimal data required to reach the earliest region.
5. Cost per account must remain bounded and size-independent.

DATA SOURCES

6. DO NOT use Wayback Machine.
7. DO NOT import external datasets.
8. DO NOT pre-seed bulk accounts.

UNLOCK LOGIC

9. Credits are consumed ONLY after a successful unlock.
10. 0 posts → no credit consumption.
11. Any failure → no credit consumption.

CACHE RULE

12. Once data is stored, NEVER re-fetch for display.

ARCHITECTURE

13. All long operations must be asynchronous.
14. Use job + polling model.
15. System must be safe under concurrent unlocks.

==================================================
2. BUSINESS MODEL (DO NOT IMPLEMENT YET)
==================================================

This section is for data model design only.

Plan: Basic
price: $9/month
credits: 3 per month
extra credits purchasable

Unlock consumes 1 credit when successful.

Same user unlocking same account again:
no additional credit.

No free tier.

Do NOT build billing logic in MVP.

==================================================
3. CORE UX RULES
==================================================

Unlock must always feel intentional.

Even when data already exists:
show a 0.5–1.0 second artificial delay.

Language in UI must use:
"Unlock"
"View"
NOT "Analyze"

==================================================
4. UI ARCHITECTURE RULE (IMPORTANT)
==================================================

The UI must be visually similar to X.

But implementation must be STELA-NATIVE.

This means:

- Do NOT use X embeds
- Do NOT mirror X DOM structure
- Do NOT depend on X UI behavior

Render posts using our own components and our own stored data.

The goal is:
lightweight
stable
fully controllable
future-extensible

Pixel-perfect cloning is NOT required.

==================================================
5. DATA SCOPE (MVP)
==================================================

Per account store:

account_id
username
display_name
avatar_url

for each post:

post_id
created_at
full_text
media (if present)
like_count
retweet_count
reply_count

Only what is required for rendering.

==================================================
6. DATABASE STRATEGY
==================================================

MVP database: SQLite

Design MUST allow future migration to PostgreSQL without schema rewrite.

Use normalized tables.

Must support:

user unlock history
credit eligibility check
account cache reuse

==================================================
7. RATE & COST CONTROL
==================================================

System must:

detect locked/private accounts before excavation
avoid starting jobs that cannot succeed
prevent retry storms
enforce per-account acquisition bounds

==================================================
8. FAILURE HANDLING
==================================================

If:

account is private
account has no posts
API error
timeout
internal exception

Then:

unlock = failed
credit = not consumed

Failures must be observable in logs.

==================================================
9. TERMINOLOGY (INTERNAL)
==================================================

Use internal term:

"excavation"

This represents the bounded process of reaching the earliest region.

This must NEVER become brute force.

==================================================
10. CURRENT TASK (ONLY DO THIS NOW)
==================================================

Scaffold the MVP codebase.

Stack:

Next.js
TypeScript
Tailwind
SQLite

Create:

- working dev server
- homepage with:
  username input
  Unlock button
  empty results list
- database schema
- minimal repository layer

Do NOT:

call X API
implement credits
implement billing
implement excavation logic

Stop after the project runs locally.

Then report:

- what was created
- how to run it
- file structure

==================================================
11. DEVELOPMENT PHASES (MILESTONES) — STELA STRICT
==================================================

Follow phases in order. Do not skip ahead.
Do not implement future phases “just in case”.
Each phase must end with:
(1) a runnable system
(2) a short report: what changed + how to test
(3) a checklist showing all exit criteria satisfied

Global rules (apply to all phases):
- Respect ALL NON-NEGOTIABLE RULES in this spec.
- Keep implementation minimal but production-shaped.
- No billing/Stripe/payment integration unless explicitly requested later.
- Never commit secrets. Ensure .env is gitignored.
- Use clear logs and error codes. Avoid silent failures.
- All long operations must be asynchronous (jobs + polling). No blocking web requests for excavations.

--------------------------------------------------
PHASE 1 — Scaffold (MVP skeleton)
--------------------------------------------------
Goal:
- Create project foundation and run locally.

Deliverables:
- Next.js + TypeScript + Tailwind
- SQLite integration (local file DB)
- DB schema migrations/initializer
- Minimal repository layer (no external calls)
- Minimal UI shell:
  - username input
  - “Unlock earliest 100” button
  - empty results list area
  - status area (idle / running / done / failed)

Exit criteria:
- `npm run dev` works, page renders without errors
- DB file can be created locally (e.g., ./stela.sqlite)
- Schema can be applied from code
- Basic lint/typecheck passes
- Folder structure is clean and documented (README “how to run”)

Do NOT:
- call X API
- implement excavation logic
- implement credits
- implement authentication or billing

--------------------------------------------------
PHASE 2 — Async job system + polling (no X yet)
--------------------------------------------------
Goal:
- Establish the “job + polling” backbone early.

Deliverables:
- Jobs table + job runner (in-process dev worker is OK)
- API routes:
  - POST /api/jobs   (create a job placeholder)
  - GET  /api/jobs/:id (poll status)
- UI polling loop:
  - pressing button creates job
  - UI polls until done/failed
- Job states: queued, running, succeeded, failed, canceled
- Structured errors saved on job record

Exit criteria:
- Clicking Unlock starts a job and UI polls correctly
- Jobs persist to DB; page refresh does not lose job state
- Failures are visible (error message stored + displayed)
- Concurrency-safe: no duplicate runners processing the same job record
- No external API calls yet

Do NOT:
- implement excavation
- implement credits/billing

--------------------------------------------------
PHASE 3 — X API connectivity (safe + bounded)
--------------------------------------------------
Goal:
- Add minimal X client and account prechecks only.

Deliverables:
- X API client using Bearer token from env (X_BEARER_TOKEN)
- Server-only usage (never expose token to browser)
- Endpoint or internal function:
  - username → user lookup (id, username, name, created_at, protected)
- Precheck logic:
  - if user not found → fail job (no credit)
  - if protected/private → fail job (no credit)
  - if suspended/withheld/unavailable → fail job (no credit)
- Observability:
  - log error codes (401/403/429/5xx)
  - store relevant error on job record

Exit criteria:
- A test lookup (e.g., cnn) succeeds and stores account metadata in DB
- Private/invalid users are detected BEFORE starting excavation
- Rate limit errors are handled and surfaced (no retry storms)
- No tweet fetching yet

Do NOT:
- implement earliest tweet retrieval
- implement credits

--------------------------------------------------
PHASE 4 — Excavation v1 (earliest 100 only, bounded, no brute force)
--------------------------------------------------
Goal:
- Implement the core “time-window jump toward oldest side” to reach earliest posts
  and store/display earliest 100.

Non-negotiable acquisition rules (repeat):
- NEVER paginate newest→oldest exhaustively.
- NEVER crawl full timeline.
- Use time-window jump + fetch toward oldest side.
- Bound the total number of calls per account.

Deliverables:
- Excavation algorithm v1:
  - start from account.created_at
  - expand time windows until posts are found / stop condition
  - always move toward the oldest side
  - stop once earliest region is reached and 100 earliest posts collected
- Hard bounds:
  - max API calls per excavation (configurable constant)
  - max retries per request = 3 with exponential backoff + jitter
  - global stop on repeated failures (avoid loops)
- Store:
  - account record
  - excavation record (params, call count, duration, outcome)
  - tweets (earliest 100) with required fields
- UI:
  - shows posts in “earliest-first” order (chronological from oldest upward)
  - shows basic engagement fields
  - shows “likes graph” (Basic includes a simple graph of like_count across the 100 posts)

Exit criteria:
- For at least 2 public accounts, earliest 100 posts are retrieved and displayed
- Calls remain bounded and do not depend on total account post count
- No newest→oldest brute force exists anywhere in code
- All failures end as failed job with stored reason
- DB contains no duplicate tweets on repeated runs

Do NOT:
- implement deep excavation beyond 100 (300/1000 are future)
- implement billing

--------------------------------------------------
PHASE 5 — Cache, idempotency, and UX consistency
--------------------------------------------------
Goal:
- Make DB reuse correct and user-visible behavior consistent.

Deliverables:
- Cache rule enforced:
  - if earliest 100 already exist for account → serve from DB
  - do NOT re-fetch for display
- Idempotency:
  - multiple simultaneous unlocks for same account collapse to one active excavation job
  - later requests attach to existing job or return cached result
- UX delay:
  - even on cache hit, add 0.5–1.0s artificial delay (configurable)
- “Same user re-unlock free” eligibility hook:
  - record user↔account unlock history
  - if same user already unlocked account → no additional credit later
  - (credits not implemented yet, but eligibility must be stored)

Exit criteria:
- Cache hit returns results without external calls
- Cache hit still shows the artificial delay
- Repeated unlock does not create duplicates, does not re-run excavation
- Concurrent unlock requests behave safely
- Unlock history is recorded in DB

Do NOT:
- implement credits yet (only store eligibility data)

--------------------------------------------------
PHASE 6 — Credits: hold/capture/release (no billing)
--------------------------------------------------
Goal:
- Implement the credit mechanics exactly as specified.

Deliverables:
- Credit ledger tables:
  - subscriptions (plan, cycle)
  - credits (balances)
  - credit_holds (TTL)
  - credit_events (audit log)
- Mechanics:
  - hold 1 credit at job start (TTL ~10 min)
  - capture on success (>=1 post stored & returned)
  - release on any failure or 0 posts
  - no double-spend under concurrency
- Policy:
  - DB hit still requires unlock and consumes credit UNLESS
    user already unlocked that account (free re-unlock for same user)
- Rate control integration:
  - AC + API rate control to avoid runaway calls under load
  - global per-user/per-IP throttling (simple)

Exit criteria:
- Success consumes exactly 1 credit
- 0 posts consumes 0
- Private/invalid/API errors consume 0
- Concurrency-safe holds prevent race conditions
- Audit log can reconstruct balances

Do NOT:
- implement Stripe/billing
- implement admin dashboards

--------------------------------------------------
PHASE 7 — Export hooks + hardening (minimal)
--------------------------------------------------
Goal:
- Keep “open upside” without building a full analytics suite.

Deliverables:
- Export hooks:
  - JSON export endpoint for unlocked dataset
  - optional CSV export (later)
- Hardening:
  - input validation (username normalization: accept “@cnn” and “cnn”)
  - security headers
  - basic abuse prevention (rate limits)
- UI polish:
  - X-like visual polish still STELA-native
  - keep light and stable

Exit criteria:
- Export produces the stored data (no re-fetch)
- Username normalization works reliably
- System remains stable under repeated use

==================================================
12. EXECUTION INSTRUCTIONS FOR THE AGENT
==================================================

- Before starting each phase, restate:
  - the phase number + goal
  - what you will NOT do
- Implement only what is required for the phase exit criteria.
- After finishing a phase, provide:
  - commands to run
  - how to test
  - file list changed
  - confirmation checklist of exit criteria
