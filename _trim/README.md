# STELA

Unlock the earliest 100 posts of any public X account.

## Setup

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
npm run dev
# Open http://localhost:3000
```

## Verify

1. `npm run dev` — homepage renders with username input, Unlock button, status badge, and empty results area
2. `npm run db:init` — creates `stela.sqlite` with tables: `accounts`, `jobs`, `tweets`, `unlocks`
3. `npm run typecheck` — no errors
4. `curl http://localhost:3000/api/health` — returns `{"status":"ok","db":true}`

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
