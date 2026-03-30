# Database Migration Status

## Current Status: Phase 6 Partial Complete

**New Database Standard: Postgres/Neon via DATABASE_URL**

### Migration Progress

- ✅ **Phase 1**: SQLite dependency audit complete
- ✅ **Phase 2**: SQLite removed from source control, Postgres established as new standard
- ✅ **Phase 3**: /api/account fully migrated to Postgres
- ✅ **Phase 4**: Core routes migrated (health + unlock status + auth verification)
- ✅ **Phase 5**: Remaining direct DB bypasses eliminated (guest unlock + dev tools)
- ✅ **Phase 6A**: Auth system fully migrated to Postgres (login + signup)
- 🔄 **Phase 6B**: Unlock system partially migrated (route updated, dependencies remain)

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

### Phase 4 Implementation Details

**Additional Postgres Repository Functions:**
- `getDatabaseHealthPg()` — Health check connectivity test
- `hasUserUnlockedAccountPg()` — Check if user has unlocked an account
- `getTemporaryUnlockPg()` — Get guest user temporary unlock by token
- `transferTemporaryUnlockPg()` — Transfer guest unlock to authenticated user

**Phase 5 Implementation Details:**

**Additional Postgres Repository Functions:**
- `getCheckoutSessionPg()` — Get guest unlock session by checkout session ID
- `getActiveJobsPg()` — Get active jobs with complex ordering for dev panel

**Newly Migrated Routes:**
- `src/app/api/guest-unlock/session/route.ts` — Guest unlock token retrieval
- `src/app/api/dev/jobs/route.ts` — Development jobs panel (GET method only)

**Enhanced Schema:**
- Added `checkout_sessions` table for Stripe session mapping
- Added `jobs` table for excavation job queue management
- Added proper indexes for performance optimization

### Phase 6 Implementation Details

**Major Postgres Repository Functions Added:**
- `createUserPg()`, `authenticateUserPg()` — User authentication system
- `getCreditBalancePg()`, `giveCreditsPg()`, `spendCreditsPg()` — Credit system
- `holdCreditsPg()`, `captureHeldPg()`, `cleanupExpiredHoldsPg()` — Credit holds
- `hasUserUnlockedStagePg()`, `recordStageUnlockPg()` — Unlock tracking
- `getCachedTweetCountPg()`, `findActiveJobForUsernamePg()` — Support functions

**Fully Migrated Components:**
- `src/lib/auth.ts` — User authentication (createUser, authenticateUser)
- `src/app/api/auth/login/route.ts` — User login functionality
- `src/app/api/auth/signup/route.ts` — User registration with temp unlock transfer

**Partially Migrated Components:**
- `src/app/api/unlock/route.ts` — Main unlock logic updated to use Postgres functions
- **Dependencies still on SQLite:** planInitialUnlock, createAndRunJob, createStageExpansionJob

**Enhanced Schema (Phase 6):**
- Added complete `users` table for authentication
- Added `credits`, `credit_holds`, `credit_events` tables for credit system
- Added `tweets` table for tweet caching

**Previously Migrated Routes:**
- `src/app/api/health/route.ts` — Database health monitoring (Phase 4)
- `src/app/api/account/unlock-status/route.ts` — User unlock status checking (Phase 4)
- `/api/auth/me` — No changes needed (JWT verification only) (Phase 4)

**Updated Schema:**
- Added `unlocks` table to Postgres schema
- Added `temporary_unlocks` table for guest user functionality
- Updated indexes for performance

**Migration Status:**
- ✅ `/api/account` — **Fully migrated to Postgres** (Phase 3)
- ✅ `/api/health` — **Fully migrated to Postgres** (Phase 4)
- ✅ `/api/account/unlock-status` — **Fully migrated to Postgres** (Phase 4)
- ✅ `/api/auth/me` — **No DB dependency** (works with current JWT system)
- ✅ `/api/guest-unlock/session` — **Fully migrated to Postgres** (Phase 5)
- ✅ `/api/dev/jobs` — **GET method migrated to Postgres** (Phase 5)
- ✅ `/api/auth/login` — **Fully migrated to Postgres** (Phase 6)
- ✅ `/api/auth/signup` — **Fully migrated to Postgres** (Phase 6)
- 🔄 `/api/unlock` — **Partially migrated** (route updated, dependencies remain)
- 🎉 **All direct DB bypasses eliminated** — No more routes using `getDb()` directly
- 🔄 Remaining routes — Still using SQLite via repository.ts functions

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

**🎉 Direct DB Bypasses: COMPLETE**
All routes now use repository pattern instead of direct `getDb()` calls.

**Next Phase - Repository Function Migration:**

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
npx tsx scripts/test-repository-functions.ts

# 3. Start dev server
npm run dev

# 4. Test all migrated endpoints (Phase 3-6)
npx tsx scripts/test-phase6-routes.ts
```

**Phase 6 Test Coverage:**
- ✅ Health check with Postgres connectivity
- ✅ Account unlock status (unlock system read-only)  
- ✅ Auth verification (JWT only, no DB)
- ✅ Account lookup (Phase 3)
- ✅ Guest unlock session token retrieval
- ✅ Dev jobs panel active job listing
- ✅ User authentication (login/signup with Postgres)
- 🔄 Main unlock route (partially migrated, may have dependency errors)

**Key Achievements:**
- 🎯 **Zero Direct DB Bypasses** - All routes follow repository pattern
- 🔐 **Auth System Complete** - User registration/login fully on Postgres
- 💳 **Credit System Ready** - Full Postgres implementation available