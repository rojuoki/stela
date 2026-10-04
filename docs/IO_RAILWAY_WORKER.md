# IO worker on Railway

## Scope

One private Railway worker service runs up to eight jobs after an authenticated
HTTP wake from Web. It drains the durable PostgreSQL queue, closes every database
connection, and then becomes idle so Railway Serverless can sleep it. Web and
worker share the dedicated IO Neon database. No Redis, public worker domain, or
persistent volume is required. A separate hourly Railway cron service provides
durable recovery when an HTTP wake cannot be delivered.

## Railway setup

1. Add an `io-worker` service from this repository, in the existing project.
   Select the release branch and leave the root directory at the repository root.
2. Configure Settings manually. The Railway console now marks Config as Code
   deprecated and blocks new services from opting in; do not select the old
   `/deploy/railway.io-worker.json` path for a new service.
   Set Builder to Dockerfile and Dockerfile Path to `deploy/io-worker.Dockerfile`.
   Set Start Command to `npm run io:worker` and Pre-deploy Command to
   `npm run io:pg:migrate && npm run io:pg:verify`.
3. Set `STELA_IO_DATABASE_URL` to the IO database's **direct** Neon connection
   URL (not the hostname containing `-pooler`). Web may continue using the pooled
   URL for the same database. If sharing variables with Web, set
   `STELA_IO_WORKER_DATABASE_URL` to the direct URL on the worker instead.
4. Set `TWITTERAPI_IO_API_KEY` directly in Railway Variables.
5. Set `STELA_IO_CONCURRENCY=8`, `STELA_IO_PROVIDER_REQUESTS_PER_SECOND=6`,
   `PORT=8080`, and a newly generated long random value in
   `STELA_IO_WORKER_WAKE_SECRET`.
6. Use one region, preferably close to Neon. Set one replica, turn Serverless
   on, use Always restart, and set Teardown to overlap 0 and draining 45 seconds.
   Do not add a public domain. Set the deployment healthcheck path to `/health`.
7. Deploy. The pre-deploy command applies and verifies the existing IO migrations.
   The image includes Node 22, Python 3, and the TypeScript runtime. No Next.js
   build is needed for this service.

`STELA_IO_DATABASE_URL` must target the IO database, never the legacy STELA DB.
For the Web service, IO Postgres selection and authentication still require its
existing `STELA_IO_USE_POSTGRES=1` and `STELA_IO_AUTH_SECRET` configuration.
The worker does not need Stripe credentials. Its wake secret is separate from
the product authentication secret.

### Web service checklist (separate from worker)

Worker variables are not automatically available to Web. In the `stela` service,
set these before testing product authentication and acquisition:

- `STELA_IO_DATABASE_URL=${{io-worker.STELA_IO_DATABASE_URL}}` (or the IO DB URL).
- `STELA_IO_USE_POSTGRES=1`.
- `STELA_IO_AUTH_SECRET`: a separate, securely generated secret entered by the operator.
- `STELA_IO_WORKER_WAKE_URL=http://${{io-worker.RAILWAY_PRIVATE_DOMAIN}}:${{io-worker.PORT}}/wake`.
- `STELA_IO_WORKER_WAKE_SECRET=${{io-worker.STELA_IO_WORKER_WAKE_SECRET}}`.

Leave legacy `DATABASE_URL` and `AUTH_SECRET` unchanged. Deploy the Web changes.
A missing IO URL produces HTTP 500 at `/api/io/auth/login`; absence of the
Postgres flag leaves post/run reads on the SQLite prototype path.

The queue transaction commits before Web schedules the wake. Web retries the
private request because the first request to a sleeping Railway service can
return 502. A notification failure does not discard the queued run.

### Hourly recovery service

Create a second service named `io-worker-recovery` from the same repository and
branch. Give it the same Dockerfile, pre-deploy command, direct IO database URL,
provider key, concurrency, request-rate, and cost-cap variables as `io-worker`.
Set its Start Command to `npm run io:worker:once` and its Cron Schedule to
`0 * * * *` (UTC). It needs neither a domain nor a wake secret. Each execution
claims any stranded work, drains the queue, closes Postgres, and exits. Railway
skips an hourly occurrence if the previous recovery execution is still active.

## Queue drain, stop, and restart behavior

- A startup check and every authenticated `/wake` request start the same
  deduplicated drain. Wakes received during a drain force one more stable-empty
  check, so a run committed at the end of a drain is not stranded.
- After all active jobs finish, the worker waits two seconds and checks once
  more. If no work exists, it releases the advisory lock and closes the entire
  PostgreSQL pool. Railway then sleeps the HTTP container after its inactivity
  window; it wakes again on private-network traffic from Web.

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
Verify in Railway and Neon metrics that the worker has zero database connections
after a drain and that Neon reaches scale-to-zero between the hourly recovery
runs. The main worker no longer polls while idle.

References:
- https://docs.railway.com/config-as-code/reference
- https://railway.com/railway.schema.json
- https://docs.railway.com/deployments/deployment-teardown
- https://docs.railway.com/deployments/restart-policy
- https://docs.railway.com/deployments/serverless
- https://docs.railway.com/networking/private-networking
- https://docs.railway.com/cron-jobs

## Local product UI after the 2026-09-20 cutover

The Web UI now always uses IO PostgreSQL; the old SQLite UI path has been retired.
`STELA_IO_USE_POSTGRES` no longer selects a fallback for public IO routes.
Run `npm run dev` for Web and `npm run io:worker:local` in a second terminal for
acquisition. The local worker loads Next-style environment files; existing
process environment still wins. It requires the direct IO database URL and
provider credentials. Starting it processes pending jobs on that database.
