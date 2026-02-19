/**
 * STELA database schema — Phase 6
 * Designed for SQLite now, PostgreSQL-portable later.
 * All timestamps stored as ISO-8601 strings.
 */

export const SCHEMA_SQL = `
-- Tracked X accounts
CREATE TABLE IF NOT EXISTS accounts (
  account_id    TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  avatar_url    TEXT,
  created_at    TEXT,
  protected     INTEGER NOT NULL DEFAULT 0,
  fetched_at    TEXT NOT NULL
);

-- Excavation jobs
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  account_username TEXT NOT NULL,
  account_id    TEXT,
  requested_limit INTEGER NOT NULL DEFAULT 100,
  hold_id       TEXT, -- Phase 6: credit hold reference
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK(status IN ('queued','running','succeeded','failed','canceled')),
  error_code    TEXT,
  error_message TEXT,
  result_json   TEXT,
  api_calls     INTEGER NOT NULL DEFAULT 0,
  fetched_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  -- Set when a 429 occurs mid-job; cleared on completion.
  -- API layer returns status=waiting_rate_limit when this is set and in the future.
  resume_at     TEXT
);

-- Stored tweets (earliest 100 per account)
CREATE TABLE IF NOT EXISTS tweets (
  post_id       TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(account_id),
  created_at    TEXT NOT NULL,
  full_text     TEXT NOT NULL,
  media_json    TEXT,
  like_count    INTEGER NOT NULL DEFAULT 0,
  retweet_count INTEGER NOT NULL DEFAULT 0,
  reply_count   INTEGER NOT NULL DEFAULT 0,
  fetched_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tweets_account ON tweets(account_id, created_at ASC);

-- User unlock history (for future credit eligibility)
CREATE TABLE IF NOT EXISTS unlocks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL DEFAULT 'anonymous',
  account_id    TEXT NOT NULL,
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  unlocked_at   TEXT NOT NULL,
  UNIQUE(user_id, account_id)
);

-- Credit system tables (Phase 6)

-- User subscriptions (plan, cycle)
CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'basic', -- 'basic' for MVP
  cycle_start   TEXT NOT NULL,
  cycle_end     TEXT NOT NULL,
  credits_per_cycle INTEGER NOT NULL DEFAULT 3,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK(status IN ('active','canceled','expired')),
  created_at    TEXT NOT NULL,
  UNIQUE(user_id)
);

-- Credit balances per user
CREATE TABLE IF NOT EXISTS credits (
  user_id       TEXT PRIMARY KEY,
  balance       INTEGER NOT NULL DEFAULT 0,
  total_earned  INTEGER NOT NULL DEFAULT 0,
  total_spent   INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL
);

-- Credit holds with TTL (prevent double-spend)
CREATE TABLE IF NOT EXISTS credit_holds (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  amount        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'held'
                CHECK(status IN ('held','captured','released')),
  UNIQUE(job_id)
);
CREATE INDEX IF NOT EXISTS idx_credit_holds_expires ON credit_holds(expires_at);

-- Credit events audit log
CREATE TABLE IF NOT EXISTS credit_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  job_id        TEXT,
  hold_id       TEXT,
  event_type    TEXT NOT NULL 
                CHECK(event_type IN ('earned','held','captured','released','expired')),
  amount        INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_events_user ON credit_events(user_id, created_at DESC);
`;
