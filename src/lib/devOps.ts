/**
 * Dev-only DB helpers. Never imported in production code paths.
 * All callers must guard with NEXT_PUBLIC_DEV_PANEL === "1".
 */
import { pgQuery } from "./db";

export function sanitizeDevUserId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return raw.match(/^[a-zA-Z0-9_-]{1,32}$/)?.[0] ?? null;
}

export function sanitizeDevUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = (raw as string).replace(/^@/, "");
  return stripped.match(/^[A-Za-z0-9_]{1,15}$/)?.[0] ?? null;
}

/** Delete all unlock rows for a user. Returns rows deleted. */
export async function devResetUser(userId: string): Promise<number> {
  const result = await pgQuery("DELETE FROM unlocks WHERE user_id = $1", [userId]);
  return result.rowCount || 0;
}

/**
 * Delete unlock row for a specific (userId, username) pair.
 * Returns rows deleted (0 if account unknown or not unlocked).
 */
export async function devResetAccount(userId: string, username: string): Promise<number> {
  const normalized = username.toLowerCase();
  const accountResult = await pgQuery("SELECT account_id FROM accounts WHERE username = $1", [normalized]);
  if (accountResult.rows.length === 0) return 0;
  
  const account = accountResult.rows[0];
  const result = await pgQuery("DELETE FROM unlocks WHERE user_id = $1 AND account_id = $2", [userId, account.account_id]);
  return result.rowCount || 0;
}

/**
 * Mark (userId, username) as unlocked immediately.
 * Creates a minimal accounts row and a sentinel succeeded job if needed,
 * then upserts the unlock record.
 */
export async function devForceUnlock(
  userId: string,
  username: string,
  cap: number,
): Promise<void> {
  const now = new Date().toISOString();
  const normalized = username.toLowerCase();

  // Ensure account row exists (upsert minimal row)
  let accountResult = await pgQuery("SELECT account_id FROM accounts WHERE username = $1", [normalized]);
  let account;
  if (accountResult.rows.length === 0) {
    const accountId = `dev_acct_${normalized}`;
    await pgQuery(
      `INSERT INTO accounts (account_id, username, display_name, protected, fetched_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (account_id) DO NOTHING`,
      [accountId, normalized, username, false, now]
    );
    account = { account_id: accountId };
  } else {
    account = accountResult.rows[0];
  }

  // Create a sentinel succeeded job (needed for unlocks FK)
  const jobId = `dev_job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await pgQuery(
    `INSERT INTO jobs (id, account_username, account_id, requested_limit, status, fetched_count, created_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [jobId, normalized, account.account_id, cap, 'succeeded', cap, now, now]
  );

  // Upsert unlock record via unified write path
  const { upsertUnlockBoundary } = await import("./unlockWrite");
  await upsertUnlockBoundary(userId, account.account_id, cap, jobId);

  // Insert a placeholder tweet so getCachedTweetCount() > 0.
  // This lets /api/unlock return cache-hit (instead of queuing a new job).
  const placeholderTweetId = `dev_tweet_${account.account_id}`;
  await pgQuery(
    `INSERT INTO tweets (post_id, account_id, created_at, full_text, like_count, retweet_count, reply_count, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (post_id) DO NOTHING`,
    [placeholderTweetId, account.account_id, "2006-03-21T00:00:00.000Z", "[dev placeholder — force unlock]", 0, 0, 0, now]
  );
}
