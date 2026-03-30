# Database Migration Status

## Current Status: Phase 3.1 Complete

**New Database Standard: Postgres/Neon via DATABASE_URL**

### Migration Progress

- ✅ **Phase 1**: SQLite dependency audit complete
- ✅ **Phase 2**: SQLite removed from source control, Postgres established as new standard
- ✅ **Phase 3.1**: Postgres connection layer introduced (coexisting with SQLite)
- ✅ **Phase 3.2**: Migrated minimal repository functions for /api/account
- ✅ **Phase 3.3**: Switched /api/account to Postgres
- ✅ **Phase 3.4**: SQLite dependency reduced for /api/account path

### Database Files Status

**SQLite Files (Local Reference Only - No Longer Runtime Target):**
- `stela.sqlite` — 7.3MB, contains current data for migration reference
- `stela.sqlite-shm`, `stela.sqlite-wal` — SQLite WAL files  
- `stela.db` — Empty file, kept for reference only

**New Standard:**
- **Connection Method**: `DATABASE_URL` environment variable
- **Database Type**: PostgreSQL (Neon for production)
- **Scope**: Both local development AND production

### Important Changes Made in Phase 2

1. **Git Tracking**: All database files removed from source control
2. **gitignore**: Updated to exclude `*.db`, `*.sqlite*` patterns  
3. **Architecture Direction**: SQLite → Postgres transition committed
4. **Local Development**: Will switch to Postgres/Neon (no longer SQLite)

### Next: Phase 3 Scope

- Build Postgres-compatible schema from audited SQLite structure
- Replace `better-sqlite3` with Postgres client (`pg` or `@vercel/postgres`)
- Update `src/lib/db/index.ts` to use `DATABASE_URL` instead of file path
- Fix `/api/account` and other DB-dependent routes
- Handle the 5 API routes that bypass `repository.ts`

**Critical**: After Phase 3, local development will require a Postgres instance (Neon recommended).

### Phase 3.1 Implementation Details

**Added Dependencies:**
- `pg` and `@types/pg` — PostgreSQL client (coexisting with better-sqlite3)

**Database Connection:**
- New `getPgPool()`, `pgQuery()`, `testPgConnection()` functions in `src/lib/db/index.ts`
- Both SQLite and Postgres connections available simultaneously

**⚠️ Required Next Step:**
Add your Neon `DATABASE_URL` to `.env` file to enable Postgres connection testing.

### Phase 3.2-3.4 Implementation Details

**New Postgres Repository Functions:**
- `getAccountByUsernamePg()` — Async Postgres account lookup
- `recordApiCallPg()` — Async Postgres telemetry logging  
- `createOrUpdateAccountPg()` — Async Postgres account insert/update

**Updated Files:**
- `src/lib/repository.ts` — Added async Postgres functions (coexisting with SQLite)
- `src/app/api/account/route.ts` — Switched to Postgres-only access
- `scripts/create-postgres-schema.sql` — Schema creation script for Neon
- `scripts/test-pg-repository.ts` — Repository function validation
- `scripts/test-api-account.ts` — End-to-end API testing

**Migration Status:**
- ✅ `/api/account` — **Fully migrated to Postgres**
- 🔄 All other routes — Still using SQLite via repository.ts

### Current System State

**Postgres Path (Production Ready):**
- `/api/account` route uses async Postgres functions exclusively
- No SQLite dependency for account lookup and caching
- Ready for Vercel deployment once DATABASE_URL is configured

**SQLite Path (Legacy - Still Active):**
- All other API routes still use synchronous SQLite functions
- 4 routes with direct `getDb()` bypass: health, dev/jobs, guest-unlock/session, stripe/webhook
- 19+ routes using SQLite via repository.ts functions

### Next Migration Targets (Priority Order)

**High Priority - Direct DB Bypasses:**
1. `src/app/api/health/route.ts` — Simple health check query
2. `src/app/api/stripe/webhook/route.ts` — Payment processing critical path  
3. `src/app/api/guest-unlock/session/route.ts` — Guest user functionality
4. `src/app/api/dev/jobs/route.ts` — Development tools

**Medium Priority - Core Features:**
5. `/api/unlock/*` routes — Main unlock functionality (7 routes)
6. `/api/auth/*` routes — User authentication (3 routes)
7. `/api/credits/*` routes — Credit system (2 routes)

**Lower Priority - Supporting Features:**
8. `/api/dev/*` routes — Development utilities (6 routes)
9. `/api/subscription/*` routes — Subscription management (2 routes)
10. Remaining `/api/purchase/*` and `/api/results/*` routes

### Testing Instructions

**Prerequisites:**
1. Add `DATABASE_URL=postgresql://...` to `.env` file
2. Run schema creation script in Neon dashboard:
   ```sql
   -- Copy content from scripts/create-postgres-schema.sql
   ```

**Validation Steps:**
```bash
# 1. Test Postgres connection
npx tsx scripts/test-pg-connection.ts

# 2. Test repository functions  
npx tsx scripts/test-pg-repository.ts

# 3. Start dev server
npm run dev

# 4. Test /api/account endpoint
npx tsx scripts/test-api-account.ts
```