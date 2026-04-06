-- STELA Postgres Schema Migration
-- Converted from SQLite schema for Neon Postgres
-- Run this in your Neon dashboard SQL editor or via psql

-- Tracked X accounts (minimal schema for /api/account)
CREATE TABLE IF NOT EXISTS accounts (
    account_id VARCHAR(50) PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    display_name TEXT,
    avatar_url TEXT,
    description TEXT,
    created_at TIMESTAMP,
    protected BOOLEAN NOT NULL DEFAULT false,
    fetched_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- API call telemetry (required by recordApiCall)
CREATE TABLE IF NOT EXISTS api_call_log (
    id SERIAL PRIMARY KEY,
    endpoint TEXT NOT NULL,
    cached BOOLEAN NOT NULL DEFAULT false,
    ts TIMESTAMP NOT NULL DEFAULT NOW()
);

-- User unlock history (for unlock status checking)
CREATE TABLE IF NOT EXISTS unlocks (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL DEFAULT 'anonymous',
    account_id VARCHAR(50) NOT NULL,
    stage INTEGER NOT NULL DEFAULT 1,
    boundary_end INTEGER NOT NULL DEFAULT 0,
    granted_count INTEGER NOT NULL DEFAULT 0,
    job_id TEXT,
    unlocked_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, account_id, stage)
);

-- Temporary unlock results (for guest users)
CREATE TABLE IF NOT EXISTS temporary_unlocks (
    token VARCHAR(100) PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL,
    username VARCHAR(50) NOT NULL,
    tweets_json TEXT NOT NULL,
    job_id TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    consumed BOOLEAN NOT NULL DEFAULT false
);

-- Stripe checkout sessions mapping (for guest unlock token retrieval)
CREATE TABLE IF NOT EXISTS checkout_sessions (
    session_id VARCHAR(200) PRIMARY KEY,
    unlock_token VARCHAR(100),
    username VARCHAR(50) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL
);

-- Excavation jobs (main job queue)
CREATE TABLE IF NOT EXISTS jobs (
    id VARCHAR(100) PRIMARY KEY,
    account_username VARCHAR(50) NOT NULL,
    account_id VARCHAR(50),
    user_id VARCHAR(50) NOT NULL DEFAULT 'anonymous',
    requested_limit INTEGER NOT NULL DEFAULT 100,
    stage INTEGER NOT NULL DEFAULT 1,
    hold_id VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','canceled')),
    error_code VARCHAR(50),
    error_message TEXT,
    result_json TEXT,
    api_calls INTEGER NOT NULL DEFAULT 0,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    started_at TIMESTAMP,
    finished_at TIMESTAMP,
    resume_at TIMESTAMP,
    resume_state TEXT,
    node_pid INTEGER
);

-- Auth users
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(100) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- User subscriptions (plan, cycle)
CREATE TABLE IF NOT EXISTS subscriptions (
    id VARCHAR(100) PRIMARY KEY,
    user_id VARCHAR(100) NOT NULL,
    plan VARCHAR(50) NOT NULL DEFAULT 'basic',
    cycle_start TIMESTAMP NOT NULL,
    cycle_end TIMESTAMP NOT NULL,
    credits_per_cycle INTEGER NOT NULL DEFAULT 3,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK(status IN ('active','canceled','expired')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
);

-- Credit balances per user
CREATE TABLE IF NOT EXISTS credits (
    user_id VARCHAR(100) PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    total_earned INTEGER NOT NULL DEFAULT 0,
    total_spent INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Credit holds with TTL (prevent double-spend)
CREATE TABLE IF NOT EXISTS credit_holds (
    id VARCHAR(100) PRIMARY KEY,
    user_id VARCHAR(100) NOT NULL,
    job_id VARCHAR(100) NOT NULL REFERENCES jobs(id),
    amount INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'held' CHECK(status IN ('held','captured','released')),
    UNIQUE(job_id)
);

-- Credit events audit log
CREATE TABLE IF NOT EXISTS credit_events (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(100) NOT NULL,
    job_id VARCHAR(100),
    hold_id VARCHAR(100),
    event_type VARCHAR(20) NOT NULL CHECK(event_type IN ('earned','held','captured','released','expired')),
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Stored tweets (earliest posts per account)
CREATE TABLE IF NOT EXISTS tweets (
    post_id VARCHAR(50) PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL REFERENCES accounts(account_id),
    created_at TIMESTAMP NOT NULL,
    full_text TEXT NOT NULL,
    media_json TEXT,
    like_count INTEGER NOT NULL DEFAULT 0,
    retweet_count INTEGER NOT NULL DEFAULT 0,
    reply_count INTEGER NOT NULL DEFAULT 0,
    fetched_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Stage results per account (immutable Stage results)
CREATE TABLE IF NOT EXISTS stage_results (
    id SERIAL PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL REFERENCES accounts(account_id),
    stage INTEGER NOT NULL,
    target_count INTEGER NOT NULL,
    collected_count INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL,
    job_id VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(account_id, stage)
);

-- Per-user extend cooldown after timeline-exhausted excavation (Phase 8 / Stage 1)
CREATE TABLE IF NOT EXISTS user_account_excavation_meta (
    user_id VARCHAR(100) NOT NULL,
    account_id VARCHAR(50) NOT NULL REFERENCES accounts(account_id),
    extend_blocked_until TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    diamond_active BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_user_account_excavation_meta_blocked ON user_account_excavation_meta(extend_blocked_until);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_api_call_log_ts ON api_call_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_unlocks_user_account ON unlocks(user_id, account_id);
CREATE INDEX IF NOT EXISTS idx_temporary_unlocks_expires ON temporary_unlocks(expires_at);
CREATE INDEX IF NOT EXISTS idx_temporary_unlocks_consumed ON temporary_unlocks(consumed);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_expires ON checkout_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status_resume ON jobs(status, resume_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_credit_holds_expires ON credit_holds(expires_at);
CREATE INDEX IF NOT EXISTS idx_credit_events_user ON credit_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_account ON tweets(account_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_stage_results_account ON stage_results(account_id, stage);

-- Verify tables created
\dt;

-- Sample query to test
SELECT 'Schema created successfully' as status;