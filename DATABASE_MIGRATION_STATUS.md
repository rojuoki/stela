# Database Migration Status

## Current Status: Phase 2 Complete

**New Database Standard: Postgres/Neon via DATABASE_URL**

### Migration Progress

- ✅ **Phase 1**: SQLite dependency audit complete
- ✅ **Phase 2**: SQLite removed from source control, Postgres established as new standard
- ⏳ **Phase 3**: Create Postgres schema and switch DB access layer  
- ⏳ **Phase 4**: Validate locally against Neon, prepare production cutover

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