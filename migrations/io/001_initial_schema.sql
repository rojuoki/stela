CREATE TABLE IF NOT EXISTS accounts (
  account_id       TEXT PRIMARY KEY,
  username         TEXT NOT NULL,
  display_name     TEXT,
  avatar_url       TEXT,
  cover_url        TEXT,
  description      TEXT,
  created_at       TIMESTAMPTZ,
  protected        BOOLEAN NOT NULL DEFAULT FALSE,
  followers_count  BIGINT NOT NULL DEFAULT 0,
  following_count  BIGINT NOT NULL DEFAULT 0,
  statuses_count   BIGINT NOT NULL DEFAULT 0,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_io_accounts_username_lower
  ON accounts (LOWER(username));

CREATE TABLE IF NOT EXISTS acquisition_runs (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT REFERENCES accounts(account_id),
  username              TEXT NOT NULL,
  requested_by_user_id  TEXT,
  provider              TEXT NOT NULL,
  collection_mode       TEXT NOT NULL,
  target_count          INTEGER,
  base_boundary         INTEGER,
  target_boundary       INTEGER,
  granted_boundary      INTEGER,
  requested_start_at    TIMESTAMPTZ,
  requested_end_at      TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'queued'
                        CHECK(status IN ('queued','running','succeeded','failed','canceled')),
  progress_message      TEXT,
  request_count         INTEGER NOT NULL DEFAULT 0,
  page_count            INTEGER NOT NULL DEFAULT 0,
  unique_count          INTEGER NOT NULL DEFAULT 0,
  candidate_count       INTEGER NOT NULL DEFAULT 0,
  duplicate_count       INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd    NUMERIC(12, 6),
  checkpoint_json       JSONB,
  result_json           JSONB,
  output_path           TEXT,
  error_code            TEXT,
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ,
  CHECK(target_count IS NULL OR target_count > 0),
  CHECK(base_boundary IS NULL OR base_boundary >= 0),
  CHECK(target_boundary IS NULL OR target_boundary >= 0),
  CHECK(granted_boundary IS NULL OR granted_boundary >= 0),
  CHECK(
    requested_start_at IS NULL OR requested_end_at IS NULL
    OR requested_start_at < requested_end_at
  )
);
CREATE INDEX IF NOT EXISTS idx_io_runs_username_created
  ON acquisition_runs (LOWER(username), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_io_runs_status_created
  ON acquisition_runs (status, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_io_one_active_run_per_account
  ON acquisition_runs (LOWER(username))
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS posts (
  post_id               TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(account_id),
  author_username       TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL,
  full_text             TEXT NOT NULL,
  url                   TEXT,
  language              TEXT,
  media_json            JSONB,
  mentions_json         JSONB,
  like_count            BIGINT NOT NULL DEFAULT 0,
  retweet_count         BIGINT NOT NULL DEFAULT 0,
  reply_count           BIGINT NOT NULL DEFAULT 0,
  quote_count           BIGINT NOT NULL DEFAULT 0,
  view_count            BIGINT NOT NULL DEFAULT 0,
  conversation_id       TEXT,
  in_reply_to_post_id   TEXT,
  in_reply_to_user_id   TEXT,
  in_reply_to_username  TEXT,
  provider              TEXT NOT NULL,
  source_run_id         TEXT REFERENCES acquisition_runs(id),
  coverage_state        TEXT NOT NULL DEFAULT 'candidate'
                        CHECK(coverage_state IN ('candidate','covered')),
  candidate_sightings   INTEGER NOT NULL DEFAULT 1,
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_io_posts_account_time
  ON posts (account_id, created_at ASC, post_id ASC);
CREATE INDEX IF NOT EXISTS idx_io_posts_account_covered_time
  ON posts (account_id, created_at ASC, post_id ASC)
  WHERE coverage_state = 'covered';
CREATE INDEX IF NOT EXISTS idx_io_posts_account_engagement
  ON posts (account_id, like_count DESC, retweet_count DESC);

CREATE TABLE IF NOT EXISTS coverage_windows (
  id                  BIGSERIAL PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES acquisition_runs(id),
  account_id          TEXT NOT NULL REFERENCES accounts(account_id),
  provider            TEXT NOT NULL,
  start_at            TIMESTAMPTZ NOT NULL,
  end_at              TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL
                      CHECK(status IN ('complete','partial','unknown')),
  resolution_basis    TEXT,
  termination_reason  TEXT,
  request_count       INTEGER NOT NULL DEFAULT 0,
  page_count          INTEGER NOT NULL DEFAULT 0,
  unique_count        INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(start_at < end_at),
  UNIQUE(run_id, start_at, end_at)
);
CREATE INDEX IF NOT EXISTS idx_io_coverage_account_provider_time
  ON coverage_windows (account_id, provider, status, start_at, end_at);
