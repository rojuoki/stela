# IO worker on Railway

## Scope

One Railway worker service runs eight jobs. The Web service and worker share
the dedicated IO Neon database. No Redis, additional tables, public worker
domain, or persistent volume is required. Local SQLite development is unchanged.

## Railway setup

1. Add an `io-worker` service from this repository, in the existing project.
   Select the release branch and leave the root directory at the repository root.
2. Configure Settings manually. The Railway console now marks Config as Code
   deprecated and blocks new services from opting in; do not select the old
   `/deploy/railway.io-worker.json` path for a new service.
   Set Builder to Dockerfile and Dockerfile Path to `deploy/io-worker.Dockerfile`.
   Set Start Command to `node --import tsx scripts/io-pg-worker.ts` and Pre-deploy
   Command to `npm run io:pg:migrate && npm run io:pg:verify`.
3. Set `STELA_IO_DATABASE_URL` to the IO database's **direct** Neon connection
   URL (not the hostname containing `-pooler`). Web may continue using the pooled
   URL for the same database. If sharing variables with Web, set
   `STELA_IO_WORKER_DATABASE_URL` to the direct URL on the worker instead.
4. Set `TWITTERAPI_IO_API_KEY` directly in Railway Variables.
5. Set `STELA_IO_CONCURRENCY=8` and
   `STELA_IO_PROVIDER_REQUESTS_PER_SECOND=6` (also the code defaults).
6. Use one region, preferably close to Neon. Set one replica, Serverless off,
   Always restart, and Teardown with overlap 0 and draining 45 seconds.
   Always restart requires a paid Railway plan. Do not add a public domain or
   copy a Web HTTP healthcheck path to the worker.
7. Deploy. The pre-deploy command applies and verifies the existing IO migrations.
   The image includes Node 22, Python 3, and the TypeScript runtime. No Next.js
   build is needed for this service.

`STELA_IO_DATABASE_URL` must target the IO database, never the legacy STELA DB.
For the Web service, IO Postgres selection and authentication still require its
existing `STELA_IO_USE_POSTGRES=1` and `STELA_IO_AUTH_SECRET` configuration.
The worker itself does not need an authentication secret or Stripe credentials.

### Web service checklist (separate from worker)

Worker variables are not automatically available to Web. In the `stela` service,
set all three before testing product authentication and acquisition:

- `STELA_IO_DATABASE_URL=${{io-worker.STELA_IO_DATABASE_URL}}` (or the IO DB URL).
- `STELA_IO_USE_POSTGRES=1`.
- `STELA_IO_AUTH_SECRET`: a separate, securely generated secret entered by the operator.

Leave legacy `DATABASE_URL` and `AUTH_SECRET` unchanged. Deploy the Web changes.
A missing IO URL produces HTTP 500 at `/api/io/auth/login`; absence of the
Postgres flag leaves post/run reads on the SQLite prototype path.

## Stop and restart behavior

- Each safe Python checkpoint is copied to the existing `checkpoint_json` column.
  This is the runner's full resume payload, not the UI progress snapshot.
- Each attempt restores that payload into a fresh, private working directory.
  Progress writes are serialized so older snapshots cannot replace newer ones.
- SIGTERM/SIGINT stops new claims and child runners, saves the last complete
  checkpoint, then requeues unfinished jobs without advancing user boundaries.
- After a hard container loss, the last DB checkpoint survives. An expired
  90-second run lease permits recovery; unfinished work since the last saved
  checkpoint may be repeated. This is not zero-loss persistence per API request.
- A session advisory lock allows only one active IO coordinator per database,
  including during deployment overlap. It needs a direct Postgres connection.
  A replacement waits for the old worker to exit; this is deployment coordination,
  not a user-facing queue. Losing the coordinator connection stops its children.
- All eight children use one shared request limiter in the working-directory root.
- A stale worker cannot import results after another worker owns the job.
- Startup settles succeeded prefix runs whose user grant was interrupted.
- Successful runs remove local artifacts and their DB checkpoint. Failed or
  interrupted local artifacts remain disposable; retention cleanup is separate.

Old in-flight rows containing only a UI progress snapshot cannot safely resume.
They fail explicitly rather than silently restarting paid acquisition from zero.
Finish such runs with the previous worker before deploying this version.

## Verification and remaining acceptance

`npm run io:test:worker-restart` uses a temporary fixture runner and a test Postgres
database. It checks SIGTERM, hard kill/expired lease, fresh-filesystem restoration,
singleton ownership, stale result rejection, and interrupted grant recovery.
`npm run io:test:resume` separately tests real Python checkpoint reconstruction.
The eight-run resource test checks parallelism and actual artifact cleanup.

Local integration tests do not replace a Railway deployment acceptance test.
The local machine has no Docker CLI, so the image build must still be verified
on a Docker host or Railway. Real eight-account resource sizing, ongoing health
monitoring/alerts, and failed-file retention remain production acceptance work.
The worker's persistent DB connection/polling can keep Neon compute awake;
do not budget assuming Neon sleeps while this worker is running.

References:
- https://docs.railway.com/config-as-code/reference
- https://railway.com/railway.schema.json
- https://docs.railway.com/deployments/deployment-teardown
- https://docs.railway.com/deployments/restart-policy

## Local product UI after the 2026-09-20 cutover

The Web UI now always uses IO PostgreSQL; the old SQLite UI path has been retired.
`STELA_IO_USE_POSTGRES` no longer selects a fallback for public IO routes.
Run `npm run dev` for Web and `npm run io:worker:local` in a second terminal for
acquisition. The local worker loads Next-style environment files; existing
process environment still wins. It requires the direct IO database URL and
provider credentials. Starting it processes pending jobs on that database.
