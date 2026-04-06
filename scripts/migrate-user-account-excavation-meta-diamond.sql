-- Add 💎 snapshot column (option A: overwrite on each successful excavation that ran the engine)
-- Run on existing Neon/Postgres if user_account_excavation_meta already exists.

ALTER TABLE user_account_excavation_meta
  ADD COLUMN IF NOT EXISTS diamond_active BOOLEAN NOT NULL DEFAULT FALSE;
