/**
 * Dev-only DB helpers. Never imported in production code paths.
 * All callers must guard with NEXT_PUBLIC_DEV_PANEL === "1".
 */
import { getDb } from "./db";

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
export function devResetUser(userId: string): number {
  const db = getDb();
  return db.prepare("DELETE FROM unlocks WHERE user_id = ?").run(userId).changes;
}

/**
 * Delete unlock row for a specific (userId, username) pair.
 * Returns rows deleted (0 if account unknown or not unlocked).
 */
export function devResetAccount(userId: string, username: string): number {
  const db = getDb();
  const normalized = username.toLowerCase();
  const account = db
    .prepare("SELECT account_id FROM accounts WHERE username = ?")
    .get(normalized) as { account_id: string } | undefined;
  if (!account) return 0;
  return db
    .prepare("DELETE FROM unlocks WHERE user_id = ? AND account_id = ?")
    .run(userId, account.account_id).changes;
}

/**
 * Mark (userId, username) as unlocked immediately.
 * Creates a minimal accounts row and a sentinel succeeded job if needed,
 * then upserts the unlock record.
 */
export function devForceUnlock(
  userId: string,
  username: string,
  cap: number,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const normalized = username.toLowerCase();

  // Ensure account row exists (upsert minimal row)
  let account = db
    .prepare("SELECT account_id FROM accounts WHERE username = ?")
    .get(normalized) as { account_id: string } | undefined;
  if (!account) {
    const accountId = `dev_acct_${normalized}`;
    db.prepare(
      `INSERT OR IGNORE INTO accounts
         (account_id, username, display_name, protected, fetched_at)
       VALUES (?, ?, ?, 0, ?)`,
    ).run(accountId, normalized, username, now);
    account = { account_id: accountId };
  }

  // Create a sentinel succeeded job (needed for unlocks FK)
  const jobId = `dev_job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(
    `INSERT INTO jobs
       (id, account_username, account_id, requested_limit,
        status, fetched_count, created_at, finished_at)
     VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?)`,
  ).run(jobId, normalized, account.account_id, cap, cap, now, now);

  // Upsert unlock record
  db.prepare(
    `INSERT OR REPLACE INTO unlocks (user_id, account_id, job_id, unlocked_at)
     VALUES (?, ?, ?, ?)`,
  ).run(userId, account.account_id, jobId, now);

  // Insert a placeholder tweet so getCachedTweetCount() > 0.
  // This lets /api/unlock return cache-hit (instead of queuing a new job).
  const placeholderTweetId = `dev_tweet_${account.account_id}`;
  db.prepare(
    `INSERT OR IGNORE INTO tweets
       (post_id, account_id, created_at, full_text, like_count, retweet_count, reply_count, fetched_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
  ).run(
    placeholderTweetId,
    account.account_id,
    "2006-03-21T00:00:00.000Z",
    "[dev placeholder — force unlock]",
    now,
  );
}
