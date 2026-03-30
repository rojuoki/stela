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

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_api_call_log_ts ON api_call_log(ts DESC);

-- Verify tables created
\dt;

-- Sample query to test
SELECT 'Schema created successfully' as status;