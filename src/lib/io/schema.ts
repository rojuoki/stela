export const IO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  account_id       TEXT PRIMARY KEY,
  username         TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name     TEXT,
  avatar_url       TEXT,
  cover_url        TEXT,
  description      TEXT,
  created_at       TEXT,
  protected        INTEGER NOT NULL DEFAULT 0,
  followers_count  INTEGER NOT NULL DEFAULT 0,
  following_count  INTEGER NOT NULL DEFAULT 0,
  statuses_count   INTEGER NOT NULL DEFAULT 0,
  fetched_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acquisition_runs (
  id                TEXT PRIMARY KEY,
  account_id        TEXT REFERENCES accounts(account_id),
  username          TEXT NOT NULL COLLATE NOCASE,
  provider          TEXT NOT NULL,
  collection_mode   TEXT NOT NULL,
  target_count      INTEGER,
  base_boundary     INTEGER,
  target_boundary   INTEGER,
  requested_start_at TEXT,
  status            TEXT NOT NULL
                    CHECK(status IN ('queued','running','succeeded','failed','canceled')),
  progress_message  TEXT,
  request_count     INTEGER NOT NULL DEFAULT 0,
  page_count        INTEGER NOT NULL DEFAULT 0,
  unique_count      INTEGER NOT NULL DEFAULT 0,
  candidate_count   INTEGER NOT NULL DEFAULT 0,
  duplicate_count   INTEGER NOT NULL DEFAULT 0,
  output_path       TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_io_runs_username_created
  ON acquisition_runs(username, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_io_one_active_run
  ON acquisition_runs(username, collection_mode, target_count)
  WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS posts (
  post_id               TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(account_id),
  author_username       TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  full_text             TEXT NOT NULL,
  url                   TEXT,
  language              TEXT,
  media_json            TEXT,
  mentions_json         TEXT,
  like_count            INTEGER NOT NULL DEFAULT 0,
  retweet_count         INTEGER NOT NULL DEFAULT 0,
  reply_count           INTEGER NOT NULL DEFAULT 0,
  quote_count           INTEGER NOT NULL DEFAULT 0,
  view_count            INTEGER NOT NULL DEFAULT 0,
  conversation_id       TEXT,
  in_reply_to_post_id   TEXT,
  in_reply_to_user_id   TEXT,
  in_reply_to_username  TEXT,
  provider              TEXT NOT NULL,
  source_run_id         TEXT REFERENCES acquisition_runs(id),
  coverage_state        TEXT NOT NULL DEFAULT 'candidate'
                        CHECK(coverage_state IN ('candidate','covered')),
  candidate_sightings   INTEGER NOT NULL DEFAULT 1,
  fetched_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_io_posts_account_time
  ON posts(account_id, created_at ASC, post_id ASC);
CREATE INDEX IF NOT EXISTS idx_io_posts_account_engagement
  ON posts(account_id, like_count DESC, retweet_count DESC);

CREATE TABLE IF NOT EXISTS coverage_windows (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT NOT NULL REFERENCES acquisition_runs(id),
  account_id          TEXT NOT NULL REFERENCES accounts(account_id),
  start_at            TEXT NOT NULL,
  end_at              TEXT NOT NULL,
  status              TEXT NOT NULL
                      CHECK(status IN ('complete','partial','unknown')),
  resolution_basis    TEXT,
  termination_reason  TEXT,
  request_count       INTEGER NOT NULL DEFAULT 0,
  page_count          INTEGER NOT NULL DEFAULT 0,
  unique_count        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  UNIQUE(run_id, start_at, end_at)
);
CREATE INDEX IF NOT EXISTS idx_io_coverage_account_time
  ON coverage_windows(account_id, start_at, end_at);
`;

// SQLite does not support ADD COLUMN IF NOT EXISTS. These are applied by the
// database opener and duplicate-column failures are ignored for existing dev DBs.
export const IO_SCHEMA_ALTER_SQL = [
  "ALTER TABLE acquisition_runs ADD COLUMN base_boundary INTEGER",
  "ALTER TABLE acquisition_runs ADD COLUMN target_boundary INTEGER",
  "ALTER TABLE acquisition_runs ADD COLUMN requested_start_at TEXT",
];
