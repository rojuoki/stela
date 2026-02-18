# PHASES — Development milestones (STELA strict)

**When to read:** When starting or finishing a phase; when checking exit criteria or "do not" bounds.

Follow phases **in order**. Do not skip ahead. Do not implement future phases "just in case".

Each phase must end with:  
(1) a runnable system  
(2) a short report: what changed + how to test  
(3) a checklist showing all exit criteria satisfied  

---

## Global rules (all phases)

- Respect ALL NON-NEGOTIABLE RULES (see [RULES.md](RULES.md)).
- Keep implementation minimal but production-shaped.
- No billing/Stripe/payment integration unless explicitly requested later.
- Never commit secrets. Ensure .env is gitignored.
- Use clear logs and error codes. Avoid silent failures.
- All long operations must be asynchronous (jobs + polling). No blocking web requests for excavations.

---

## Phase 1 — Scaffold (MVP skeleton)

**Goal:** Create project foundation and run locally.

**Deliverables:**

- Next.js + TypeScript + Tailwind  
- SQLite integration (local file DB)  
- DB schema migrations/initializer  
- Minimal repository layer (no external calls)  
- Minimal UI shell: username input, "Unlock earliest 100" button, empty results list area, status area (idle / running / done / failed)

**Exit criteria:**

- `npm run dev` works, page renders without errors  
- DB file can be created locally (e.g., ./stela.sqlite)  
- Schema can be applied from code  
- Basic lint/typecheck passes  
- Folder structure is clean and documented (README "how to run")

**Do NOT:** call X API; implement excavation logic; implement credits; implement authentication or billing.

---

## Phase 2 — Async job system + polling (no X yet)

**Goal:** Establish the "job + polling" backbone early.

**Deliverables:**

- Jobs table + job runner (in-process dev worker is OK)  
- API routes: POST /api/jobs (create placeholder), GET /api/jobs/:id (poll status)  
- UI polling loop: button creates job, UI polls until done/failed  
- Job states: queued, running, succeeded, failed, canceled  
- Structured errors saved on job record  

**Exit criteria:** Unlock starts a job and UI polls; jobs persist; failures visible; concurrency-safe; no external API calls yet.

**Do NOT:** implement excavation; implement credits/billing.

---

## Phase 3 — X API connectivity (safe + bounded)

**Goal:** Minimal X client and account prechecks only.

**Deliverables:**

- X API client using Bearer token from env (X_BEARER_TOKEN), server-only  
- username → user lookup (id, username, name, created_at, protected)  
- Precheck: not found / protected / suspended / withheld / unavailable → fail job (no credit)  
- Observability: log error codes (401/403/429/5xx), store relevant error on job record  

**Exit criteria:** Test lookup (e.g. cnn) succeeds and stores account metadata; private/invalid detected before excavation; rate limit handled; no tweet fetching yet.

**Do NOT:** implement earliest tweet retrieval; implement credits.

---

## Phase 4 — Excavation v1 (earliest 100 only, bounded)

**Goal:** Time-window jump toward oldest side; store and display earliest 100.

**Rules (repeat):** NEVER paginate newest→oldest exhaustively. NEVER crawl full timeline. Time-window jump + bound total calls per account.

**Deliverables:**

- Excavation algorithm: start from account.created_at; expand time windows toward oldest; stop when earliest region reached and 100 posts collected  
- Bounds: max API calls per excavation (configurable); max retries per request = 3 with exponential backoff + jitter; global stop on repeated failures  
- Store: account, excavation record (params, call count, duration, outcome), tweets (earliest 100)  
- UI: earliest-first order; basic engagement; "likes graph" (like_count across 100 posts)  

**Exit criteria:** ≥2 public accounts get earliest 100; calls bounded; no brute force; failures = failed job with reason; no duplicate tweets on repeated runs.

**Do NOT:** deep excavation beyond 100; billing.

---

## Phase 5 — Cache, idempotency, UX consistency

**Goal:** DB reuse correct; user-visible behavior consistent.

**Deliverables:**

- Cache: if earliest 100 exist for account → serve from DB; do NOT re-fetch  
- Idempotency: multiple simultaneous unlocks for same account → one active job; later requests attach or get cache  
- UX delay: cache hit still 0.5–1.0s artificial delay (configurable)  
- Unlock history: same user re-unlock same account → no additional credit later (eligibility stored; credits not implemented yet)  

**Exit criteria:** Cache hit = no external calls + delay; no duplicates/re-run; concurrent unlocks safe; unlock history in DB.

**Do NOT:** implement credits yet (only eligibility data).

---

## Phase 6 — Credits: hold/capture/release (no billing)

**Goal:** Credit mechanics as specified.

**Deliverables:**

- Tables: subscriptions, credits, credit_holds (TTL), credit_events (audit)  
- Hold 1 at job start (TTL ~10 min); capture on success (≥1 post); release on failure or 0 posts; no double-spend  
- Policy: DB hit still requires unlock and consumes credit UNLESS user already unlocked that account  
- Rate control: AC + API rate control; per-user/per-IP throttling (simple)  

**Exit criteria:** Success = 1 credit; 0 posts = 0; private/errors = 0; concurrency-safe; audit log can reconstruct balances.

**Do NOT:** Stripe/billing; admin dashboards.

---

## Phase 7 — Export hooks + hardening (minimal)

**Goal:** Open upside without full analytics suite.

**Deliverables:** JSON export for unlocked dataset; optional CSV later; username normalization (@cnn / cnn); security headers; basic abuse prevention; X-like UI polish (STELA-native).

**Exit criteria:** Export from stored data; normalization reliable; stable under repeated use.

---

## Execution instructions for the agent

- Before starting each phase, restate: phase number + goal, and what you will NOT do.
- Implement only what is required for the phase exit criteria.
- After finishing a phase, provide: commands to run; how to test; file list changed; confirmation checklist of exit criteria.
