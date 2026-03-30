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

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_api_call_log_ts ON api_call_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_unlocks_user_account ON unlocks(user_id, account_id);
CREATE INDEX IF NOT EXISTS idx_temporary_unlocks_expires ON temporary_unlocks(expires_at);
CREATE INDEX IF NOT EXISTS idx_temporary_unlocks_consumed ON temporary_unlocks(consumed);

-- Verify tables created
\dt;

-- Sample query to test
SELECT 'Schema created successfully' as status;