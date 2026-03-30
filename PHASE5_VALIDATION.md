# Phase 5 Validation Guide

## Prerequisites

1. **DATABASE_URL** must be set in `.env` with your Neon connection string:
   ```env
   DATABASE_URL=postgresql://user:password@host/database
   ```

2. **Postgres schema** must be created in Neon dashboard:
   ```bash
   # Copy and run the contents of scripts/create-postgres-schema.sql in Neon SQL editor
   ```

## Validation Steps

### 1. Test Postgres Repository Functions
```bash
npx tsx scripts/test-repository-functions.ts
```
Expected output:
- ✅ Database connected successfully
- ✅ Health check result: { healthy: true, dbValue: 1 }
- ✅ null (expected for test session)
- ✅ Active jobs retrieved: X jobs found

### 2. Test API Routes End-to-End
```bash
# Start Next.js dev server first
npm run dev

# In another terminal, run:
npx tsx scripts/test-phase4-routes.ts
```

Expected results:
- ✅ Health Check (Postgres connectivity)
- ✅ Account Unlock Status (read-only unlock route)
- ✅ Auth Me (JWT verification, no DB needed)
- ✅ Account Lookup (Phase 3 - already migrated)
- ✅ Guest Unlock Session (expect 404 for test session)
- ✅ Dev Jobs Panel (if NEXT_PUBLIC_DEV_PANEL=1)

### 3. Manual Testing

**Health endpoint:**
```bash
curl http://localhost:3000/api/health
```
Should return: `{"status":"ok","db":true,"postgres":true,"value":1}`

**Guest unlock session:**
```bash
curl "http://localhost:3000/api/guest-unlock/session?session_id=test"
```
Should return 404 (expected for test session)

**Dev jobs (if dev panel enabled):**
```bash
curl http://localhost:3000/api/dev/jobs
```
Should return job list or empty array

## What Changed in Phase 5

### Eliminated Direct DB Bypasses
- ❌ **Before:** Routes called `getDb()` directly
- ✅ **After:** All routes use repository pattern

### Routes Migrated
1. `/api/guest-unlock/session` — Now uses `getCheckoutSessionPg()`
2. `/api/dev/jobs` (GET method) — Now uses `getActiveJobsPg()`

### Architecture Achievement
🎯 **Zero Direct DB Bypasses** — All API routes now follow consistent repository pattern

## Next Steps

Phase 5 completes the direct DB bypass elimination. The next phase should focus on migrating the remaining SQLite-based repository functions to Postgres, starting with the most critical business logic routes.

Recommended next targets:
1. Main unlock execution routes
2. Authentication processing routes  
3. Credit system routes
4. Stripe webhook (after gaining more experience)