# STELA IO operations runbook

## Deploy gate

Before deploying Web or worker:

1. Run `npm ci` and `npm run verify`.
2. Run `npm run io:pg:migrate` and `npm run io:pg:verify` against the target IO database.
3. Confirm Web has `STELA_IO_DATABASE_URL`, `STELA_IO_AUTH_SECRET`,
   `STELA_IO_RATE_LIMIT_SALT`, `TWITTERAPI_IO_API_KEY`,
   `STELA_IO_WORKER_WAKE_URL`, and `STELA_IO_WORKER_WAKE_SECRET`.
4. Confirm the worker uses a direct (non-pooler) IO database URL and the Web and
   worker point at the same database. Confirm the worker has the matching wake
   secret and its private HTTP health endpoint is available.
5. Confirm `NEXT_PUBLIC_STELA_SUPPORT_EMAIL` and the service operator identity
   have been reviewed before public launch.

Do not run a real unlock as part of an automatic deploy. It contacts a metered
provider. Use the offline verification suite, then perform a separately approved
single-account production acceptance run.

## Health and alerts

Web health is `GET /api/io/health`. It verifies the dedicated IO database and
reports queued, running, and stale-leased jobs. Configure the hosting monitor to
check it every minute and alert after three consecutive non-200 responses.

Alert on these JSON log events:

- `health_database_failed` or `worker_fatal_error`: page immediately;
- `health_stale_worker_lease`: page when repeated for two minutes;
- `worker_coordinator_connection_lost`: page immediately;
- `rate_limit_rejected`: trend and investigate sustained increases, but do not
  page for isolated requests.

Also alert when the oldest queued run is more than five minutes old. A busy queue
may be valid, so inspect worker logs and provider status before changing data.

## Maintenance and retention

`npm run io:maintenance` is a read-only dry run. It reports expired request-limit
rows and failed/interrupted worker artifact directories older than seven days.
Set `STELA_IO_FAILED_ARTIFACT_RETENTION_DAYS` to change that period. After reviewing
the exact work directory, run `npm run io:maintenance -- --apply` from a scheduled
worker task. The script only removes UUID-like attempt directories inside the
configured `STELA_IO_WORK_DIRECTORY` and expired database limiter rows.

Never delete active attempt files. Successful attempts are already removed by the
worker; failed artifacts exist for short-term diagnosis.

## Backup and restore

Enable the database provider's continuous backups or point-in-time restore before
public launch. Keep a second logical backup outside the production database
account on a regular schedule:

```sh
pg_dump --format=custom --no-owner --no-acl "$STELA_IO_DATABASE_URL" --file stela-io.dump
```

Restore rehearsals must use a new, isolated database:

```sh
createdb stela_io_restore_test
pg_restore --clean --if-exists --no-owner --no-acl --dbname stela_io_restore_test stela-io.dump
```

Then point a temporary process at the restored database and run
`npm run io:pg:verify`. Compare counts for `accounts`, `posts`, `user_unlocks`,
`user_range_unlocks`, and `acquisition_runs`. Never rehearse with the production
worker running against the restore target.

Record the backup timestamp, restore duration, verification result, and operator.
Repeat the restore rehearsal after schema changes and at least quarterly.

## Incident sequence

1. Pause the worker if it is creating repeated failures; leave Web reads online
   when the database is healthy.
2. Preserve structured logs and failed attempt artifacts.
3. Check `/api/io/health`, database availability, worker coordinator logs, and
   provider status in that order.
4. For expired leases, restart one worker instance only. The queue resumes from
   PostgreSQL checkpoints.
5. After recovery, verify no user boundary advanced past confirmed covered posts.
6. Document the time window, affected run IDs, resolution, and follow-up.
