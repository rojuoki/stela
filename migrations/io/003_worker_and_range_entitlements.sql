ALTER TABLE acquisition_runs
  ADD COLUMN worker_id TEXT,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN range_request_id TEXT;

CREATE INDEX idx_io_runs_claimable
  ON acquisition_runs (status, lease_expires_at, created_at ASC);


CREATE TABLE user_range_unlocks (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  start_at      TIMESTAMPTZ NOT NULL,
  end_at        TIMESTAMPTZ NOT NULL,
  source_run_id TEXT REFERENCES acquisition_runs(id) ON DELETE SET NULL,
  unlocked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_id, start_at, end_at),
  CHECK(start_at < end_at)
);
CREATE INDEX idx_io_range_unlocks_user_account_time
  ON user_range_unlocks (user_id, account_id, start_at, end_at);

CREATE TABLE range_unlock_requests (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id    TEXT REFERENCES accounts(account_id) ON DELETE CASCADE,
  username      TEXT NOT NULL,
  start_at      TIMESTAMPTZ NOT NULL,
  end_at        TIMESTAMPTZ NOT NULL,
  provider      TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','canceled')),
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  CHECK(start_at < end_at)
);
CREATE INDEX idx_io_range_requests_user_created
  ON range_unlock_requests (user_id, created_at DESC);
CREATE UNIQUE INDEX idx_io_one_active_range_request
  ON range_unlock_requests (user_id, LOWER(username), start_at, end_at)
  WHERE status IN ('queued', 'running');

ALTER TABLE acquisition_runs
  ADD CONSTRAINT acquisition_runs_range_request_id_fkey
  FOREIGN KEY (range_request_id) REFERENCES range_unlock_requests(id) ON DELETE CASCADE;
CREATE INDEX idx_io_runs_range_request ON acquisition_runs (range_request_id);
