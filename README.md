# STELA

Unlock and explore the earliest posts of a public X account.

The current product is the `/io` application. It uses a dedicated PostgreSQL
database, authenticated user boundaries, a persistent acquisition worker, and
TwitterAPI.io-backed collection. Legacy routes redirect into the IO product and
are retained only as migration reference.

## Local development

```bash
npm install
cp -n .env.example .env.local
npm run dev:web
```

Open `http://localhost:3000/io`. `dev:web` starts the local PostgreSQL database
and the web application without an acquisition worker, so browsing the UI
cannot start provider work. When acquisition is intentionally required, use
`npm run dev` instead; it starts the same web stack plus the local worker.

Run the complete offline quality gate before pushing:

```bash
npm run verify
```

Operational health is available at `/api/io/health`. Monitoring, retention,
backup, and restore procedures are documented in `docs/IO_OPERATIONS.md`.

It checks TypeScript, the active IO product lint scope, coverage/prefix/range
fixtures, route authorization, and a production build. Tests that need real
provider credentials or intentionally spend API credit remain separate.

Run the isolated PostgreSQL/worker integration suite with
`npm run io:test:integration`. It creates a temporary database, uses fixture
runners only, exercises restart and eight-worker behavior, then removes the
database. It never shares the development queue.

## TwitterAPI.io measurement tools

Relevant environment values:

```dotenv
TWITTERAPI_IO_API_KEY=replace_me
STELA_IO_DATABASE_PATH=./data/stela-io.sqlite
# Optional prototype tuning. Normal jobs do not impose implicit request or cost stops.
STELA_IO_REQUEST_INTERVAL=0.7
# Set either only for an explicit operator emergency guardrail.
# STELA_IO_MAX_REQUESTS=500
# STELA_IO_MAX_ESTIMATED_COST_USD=2.00
STELA_IO_PYTHON=python3
```

The prototype UI reads `accounts` and `posts`, while execution state and
operational coverage observations are kept in `acquisition_runs` and
`coverage_windows`. The real API job is deliberately local/in-process for now:
one job at a time, and restarting the dev server interrupts it.

### Resume a saved TwitterAPI.io checkpoint

The measurement runner automatically restores an existing checkpoint passed to
`--checkpoint`, skips completed windows, and continues from the saved
oldest-side coverage frontier. The saved nasa checkpoint can be resumed with:

```bash
python3 scripts/measure_twitterapi_io_1000.py nasa \
  --checkpoint results/twitterapi-io-1000/benchmark-nasa.json.checkpoint.json \
  --output results/twitterapi-io-1000/nasa-resumed.json
```

At the next safe window boundary it writes checkpoint schema v3, including the
next resume position. The spend estimate uses TwitterAPI.io's published tweet
and profile rates; an explicit budget may be passed when an operator needs an
emergency stop, but it is not a normal collection limit or billing receipt.

Offline fixture validation:

```bash
npm run io:test:resume
```

### Broad account survey

To sample many accounts without allowing one slow or problematic account to
block the survey:

```bash
npm run io:batch
```

The batch samples 50 oldest-side posts per account, gives each account a
separate checkpoint and `$0.04` estimated-cost limit, retries once, then moves
on. Results, checkpoints, and per-attempt logs are written under
`results/twitterapi-io-batch/`.

For a slower 1000-post efficiency survey, pass an explicit account list and a
batch reservation limit:

```bash
python3 scripts/run-twitterapi-io-batch.py \
  --accounts BarackObama elonmusk sama BillGates SpaceX OpenAI Google Microsoft \
    YouTube Netflix nytimes CNN BBCWorld Reuters AP WIRED \
  --target-count 1000 \
  --account-cost-limit 0.18 \
  --total-cost-limit 1.28 \
  --max-requests 500 \
  --concurrency 4 \
  --provider-request-rate 6 \
  --output-directory results/twitterapi-io-1000-survey
```

Each result includes per-window termination reasons, cursor pages, raw and
unique counts, duplicates, splits, elapsed time, and estimated cost.
The batch runner keeps cursor pagination serial within each account, but can
run accounts concurrently. A provider-wide file-backed limiter and cost
reservations coordinate the workers; use `--concurrency 1` for the legacy
serial behavior.

The collector uses the bulk adaptive span policy: start at seven days, expand
to 30 days and then 120 days when a resolved normal window yields fewer than
100 posts, then use the remaining span to the next calendar year. A dense
normal window keeps its width. A 20-page-capped parent is discarded and split;
only resolved child windows contribute posts or coverage.

## Legacy setup notes

```bash
cd ~/stela
npm install
```

## Initialize Database

```bash
npm run db:init
# Creates ./stela.sqlite with all tables
```

## Run Dev Server

```bash
npm run dev:web
# Open http://localhost:3000
```

## Verify

`npm run verify` is the canonical offline check. PostgreSQL worker integration,
restart/resource tests, and paid provider checks are intentionally run
separately because they require additional services or credentials.

## Unlock + Jobs API (Phase 3)

### Start an unlock

```bash
curl -X POST http://localhost:3000/api/unlock \
  -H "Content-Type: application/json" \
  -d '{"username": "cnn"}'
# → {"jobId":"<uuid>","status":"queued"}
```

### Poll job status

```bash
curl http://localhost:3000/api/jobs/<jobId>
# → {"jobId":"...","status":"running|succeeded|failed","result":{...},"error":{...}}
```

### Job lifecycle

`queued` → `running` → `succeeded` | `failed`

On success, `result` contains the full `ExcavationResult`. On failure, `error` has `{code, message}`.
Unlock history is recorded in the `unlocks` table on success.

## Unlock API (Phase 3 — Jobs + Polling)

### Create an unlock job

```bash
curl -s -X POST http://localhost:3000/api/unlock \
  -H "Content-Type: application/json" \
  -d '{"username": "cnn"}'
# → {"jobId":"<uuid>","status":"queued"}  (HTTP 202)
```

### Poll job status

```bash
curl -s http://localhost:3000/api/jobs/<jobId>
# → { jobId, status, username, fetchedCount, apiCalls, error?, result? }
```

Job statuses: `queued` → `running` → `succeeded` | `failed`

On success, `result` contains the full excavation result. On failure, `error` contains `{ code, message }`.

### Error codes

| Code | Meaning |
|---|---|
| `PROTECTED_OR_SUSPENDED_OR_NOT_FOUND` | Account inaccessible |
| `RATE_LIMIT` | X API 429 |
| `API_ERROR` | Other API failure |
| `EXCAVATION_ERROR` | Internal excavation error |
| `INTERNAL_ERROR` | Unhandled exception |

## Excavation API (Phase 2)

### Environment

Add your X API Bearer token to `.env`:

```
X_BEARER_TOKEN=your_token_here
```

### Usage

```bash
curl -X POST http://localhost:3000/api/excavate/earliest \
  -H "Content-Type: application/json" \
  -d '{"username": "cnn"}'
```

### Response shape

```json
{
  "username": "cnn",
  "userId": "759251",
  "createdAt": "2007-02-03T02:53:05.000Z",
  "requestedLimit": 100,
  "fetchedCount": 100,
  "stopReason": "OK_LIMIT_REACHED",
  "apiCalls": 5,
  "storedNewCount": 100,
  "errors": []
}
```

### Stop reasons

| Value | Meaning |
|---|---|
| `OK_LIMIT_REACHED` | Got requested number of tweets |
| `ACCOUNT_HAS_LESS_THAN_LIMIT` | Account has fewer tweets than limit |
| `PROTECTED_OR_SUSPENDED_OR_NOT_FOUND` | Account is private, suspended, or doesn't exist |
| `RATE_LIMIT` | Hit X API rate limit (429) |
| `API_ERROR` | Other API error |
| `MAX_API_CALLS_REACHED` | Hit safety ceiling (50 calls) |

## Project Structure

```
stela/
├── scripts/
│   └── init-db.ts            # Standalone DB initializer
├── src/
│   ├── app/
│   │   ├── api/health/route.ts  # Health check (verifies DB)
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx           # Main UI shell
│   └── lib/
│       ├── db/
│       │   ├── index.ts       # DB connection + auto-schema
│       │   └── schema.ts      # SQL schema definition
│       ├── excavate.ts        # Earliest-100 algorithm
│       ├── repository.ts      # Data access layer
│       └── xclient.ts         # X API v2 client
├── .env                       # DATABASE_PATH (gitignored)
├── .gitignore
├── package.json
└── README.md
```
