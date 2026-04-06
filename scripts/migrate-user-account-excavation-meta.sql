-- One-off migration: extend cooldown after timeline exhaust (user × account)
-- Run in Neon/psql if the table is missing on an existing database.

CREATE TABLE IF NOT EXISTS user_account_excavation_meta (
    user_id VARCHAR(100) NOT NULL,
    account_id VARCHAR(50) NOT NULL REFERENCES accounts(account_id),
    extend_blocked_until TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    diamond_active BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_user_account_excavation_meta_blocked ON user_account_excavation_meta(extend_blocked_until);
