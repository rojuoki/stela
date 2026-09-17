CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_io_users_email_lower
  ON users (LOWER(email));

ALTER TABLE acquisition_runs
  ADD CONSTRAINT acquisition_runs_requested_by_user_id_fkey
  FOREIGN KEY (requested_by_user_id) REFERENCES users(id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS user_unlocks (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  boundary_end  INTEGER NOT NULL CHECK(boundary_end > 0),
  source_run_id TEXT REFERENCES acquisition_runs(id) ON DELETE SET NULL,
  unlocked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_io_unlocks_user_updated
  ON user_unlocks (user_id, unlocked_at DESC);
