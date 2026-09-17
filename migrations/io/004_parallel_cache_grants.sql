DROP INDEX IF EXISTS idx_io_one_active_run_per_account;

CREATE UNIQUE INDEX idx_io_one_active_acquisition_per_account
  ON acquisition_runs (LOWER(username))
  WHERE status IN ('queued', 'running')
    AND collection_mode <> 'prefix_grant';

CREATE INDEX idx_io_active_grants_user_account
  ON acquisition_runs (requested_by_user_id, LOWER(username), created_at DESC)
  WHERE status IN ('queued', 'running')
    AND collection_mode = 'prefix_grant';
