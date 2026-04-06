-- Phase 2: Collapse unlocks to single row per (user_id, account_id)
-- 
-- Before running: ensure no active writes (pre-launch, low traffic)
-- Rollback: see migrations/002_rollback.sql

-- Step 1: Keep only the row with MAX(boundary_end) per (user_id, account_id)
DELETE FROM unlocks
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, account_id) id
  FROM unlocks
  ORDER BY user_id, account_id, boundary_end DESC
);

-- Step 2: Drop old unique constraint
ALTER TABLE unlocks DROP CONSTRAINT unlocks_user_id_account_id_stage_key;

-- Step 3: Add new unique constraint
ALTER TABLE unlocks ADD CONSTRAINT unlocks_user_id_account_id_key UNIQUE (user_id, account_id);

-- Step 4: Drop stage and granted_count columns
ALTER TABLE unlocks DROP COLUMN stage;
ALTER TABLE unlocks DROP COLUMN granted_count;
