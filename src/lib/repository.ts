/**
 * STELA repository layer — Phase 5
 * Pure DB read/write. No external API calls.
 */

import { getDb } from "./db";
import { logger, generateTraceId } from './logger';

export interface Account {
  account_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | null;
  protected: number;
  fetched_at: string;
}

export interface Tweet {
  post_id: string;
  account_id: string;
  created_at: string;
  full_text: string;
  media_json: string | null;
  like_count: number;
  retweet_count: number;
  reply_count: number;
  fetched_at: string;
}

export function getAccountByUsername(username: string): Account | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM accounts WHERE username = ?")
    .get(username.toLowerCase()) as Account | undefined;
}

export function getTweetsByAccount(accountId: string): Tweet[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM tweets WHERE account_id = ? ORDER BY created_at ASC LIMIT 100"
    )
    .all(accountId) as Tweet[];
}

/** Count cached tweets for an account */
export function getCachedTweetCount(accountId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM tweets WHERE account_id = ?")
    .get(accountId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/** Check if user already unlocked this account */
export function hasUserUnlockedAccount(userId: string, accountId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 FROM unlocks WHERE user_id = ? AND account_id = ?")
    .get(userId, accountId);
  return !!row;
}

/** Record unlock (idempotent via UNIQUE constraint) */
export function recordUnlock(userId: string, accountId: string, jobId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO unlocks (user_id, account_id, job_id, unlocked_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, accountId, jobId, new Date().toISOString());
}

/**
 * Find an active (queued/running) job for a given username.
 * Used to collapse concurrent unlock requests into one job.
 */
export function findActiveJobForUsername(username: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id FROM jobs WHERE account_username = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1"
    )
    .get(username.toLowerCase()) as { id: string } | undefined;
  return row?.id ?? null;
}

// ─── Credit System (Phase 6) ───────────────────────────

export interface CreditBalance {
  user_id: string;
  balance: number;
  total_earned: number;
  total_spent: number;
  updated_at: string;
}

export interface CreditHold {
  id: string;
  user_id: string;
  job_id: string;
  amount: number;
  created_at: string;
  expires_at: string;
  status: 'held' | 'captured' | 'released';
}

/** Get credit balance for a user (creates if doesn't exist) */
export function getCreditBalance(userId: string): CreditBalance {
  const db = getDb();
  let balance = db
    .prepare("SELECT * FROM credits WHERE user_id = ?")
    .get(userId) as CreditBalance | undefined;
  
  if (!balance) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO credits (user_id, balance, total_earned, total_spent, updated_at)
      VALUES (?, 0, 0, 0, ?)
    `).run(userId, now);
    
    balance = {
      user_id: userId,
      balance: 0,
      total_earned: 0,
      total_spent: 0,
      updated_at: now,
    };
  }
  
  return balance;
}

/** Hold credits for a job (returns hold ID or null if insufficient balance) */
export function holdCredits(userId: string, jobId: string, amount: number = 1): string | null {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes TTL
  const holdId = `hold_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  try {
    return db.transaction(() => {
      // Check balance
      const balance = getCreditBalance(userId);
      if (balance.balance < amount) {
        return null; // Insufficient balance
      }
      
      // Create hold
      db.prepare(`
        INSERT INTO credit_holds (id, user_id, job_id, amount, created_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'held')
      `).run(holdId, userId, jobId, amount, now.toISOString(), expiresAt.toISOString());
      
      // Update balance (deduct held amount)
      db.prepare(`
        UPDATE credits SET balance = balance - ?, updated_at = ?
        WHERE user_id = ?
      `).run(amount, now.toISOString(), userId);
      
      // Log event
      db.prepare(`
        INSERT INTO credit_events (user_id, job_id, hold_id, event_type, amount, balance_after, reason, created_at)
        VALUES (?, ?, ?, 'held', ?, ?, ?, ?)
      `).run(userId, jobId, holdId, amount, balance.balance - amount, `Hold for job ${jobId}`, now.toISOString());
      
      return holdId;
    })();
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({
      trace_id: jobId || generateTraceId(), // Use jobId as trace_id fallback
      job_id: jobId || null,
      service: 'lib',
      event: 'job_failed', // Credit hold failure affects job
      user_id: userId,
      amount,
      error_code: 'CREDIT_HOLD_FAILED',
      err_name: error.constructor.name,
      err_message: error.message,
    }, `Credit hold failed for user ${userId} job ${jobId} amount ${amount}`);
    return null;
  }
}

/**
 * Immediately spend credits without a hold (for synchronous operations like
 * cache-hit unlocks where there is no async job and no hold/capture cycle).
 * Returns false if balance is insufficient or the transaction fails.
 */
export function spendCredits(userId: string, amount: number, reason: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    return (db.transaction(() => {
      const balance = getCreditBalance(userId);
      if (balance.balance < amount) return false;

      db.prepare(`UPDATE credits SET balance = balance - ?, total_spent = total_spent + ?, updated_at = ? WHERE user_id = ?`)
        .run(amount, amount, now, userId);

      db.prepare(`
        INSERT INTO credit_events (user_id, event_type, amount, balance_after, reason, created_at)
        VALUES (?, 'captured', ?, ?, ?, ?)
      `).run(userId, amount, balance.balance - amount, reason, now);

      return true;
    }))() as boolean;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({
      trace_id: generateTraceId(), // Generate trace_id for system operation
      job_id: null, // No specific job associated
      service: 'lib',
      event: 'job_failed', // Credit operation failure
      user_id: userId,
      amount,
      reason,
      error_code: 'CREDIT_SPEND_FAILED',
      err_name: error.constructor.name,
      err_message: error.message,
    }, `Credit spend failed for user ${userId} amount ${amount}: ${reason}`);
    return false;
  }
}

/** Capture held credits (consume them on successful unlock) */
export function captureHeld(holdId: string, reason: string = 'Unlock successful'): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  
  try {
    return db.transaction(() => {
      // Get hold
      const hold = db.prepare("SELECT * FROM credit_holds WHERE id = ? AND status = 'held'")
        .get(holdId) as CreditHold | undefined;
      
      if (!hold) {
        return false; // Hold not found or already processed
      }
      
      // Mark as captured
      db.prepare(`
        UPDATE credit_holds SET status = 'captured' WHERE id = ?
      `).run(holdId);
      
      // Update totals
      db.prepare(`
        UPDATE credits SET total_spent = total_spent + ?, updated_at = ?
        WHERE user_id = ?
      `).run(hold.amount, now, hold.user_id);
      
      // Log event
      const balance = getCreditBalance(hold.user_id);
      db.prepare(`
        INSERT INTO credit_events (user_id, job_id, hold_id, event_type, amount, balance_after, reason, created_at)
        VALUES (?, ?, ?, 'captured', ?, ?, ?, ?)
      `).run(hold.user_id, hold.job_id, holdId, hold.amount, balance.balance, reason, now);
      
      return true;
    })();
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({
      trace_id: holdId, // Use holdId as trace_id
      job_id: null, // We don't have job_id directly here, could be extracted from hold if needed
      service: 'lib',
      event: 'job_failed', // Credit capture failure affects job completion
      hold_id: holdId,
      reason,
      error_code: 'CREDIT_CAPTURE_FAILED',
      err_name: error.constructor.name,
      err_message: error.message,
    }, `Credit capture failed for hold ${holdId}: ${reason}`);
    return false;
  }
}

/** Release held credits (return them on failure/0 posts) */
export function releaseHeld(holdId: string, reason: string = 'Unlock failed'): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  
  try {
    return db.transaction(() => {
      // Get hold
      const hold = db.prepare("SELECT * FROM credit_holds WHERE id = ? AND status = 'held'")
        .get(holdId) as CreditHold | undefined;
      
      if (!hold) {
        return false; // Hold not found or already processed
      }
      
      // Mark as released
      db.prepare(`
        UPDATE credit_holds SET status = 'released' WHERE id = ?
      `).run(holdId);
      
      // Return credits to balance
      db.prepare(`
        UPDATE credits SET balance = balance + ?, updated_at = ?
        WHERE user_id = ?
      `).run(hold.amount, now, hold.user_id);
      
      // Log event
      const balance = getCreditBalance(hold.user_id);
      db.prepare(`
        INSERT INTO credit_events (user_id, job_id, hold_id, event_type, amount, balance_after, reason, created_at)
        VALUES (?, ?, ?, 'released', ?, ?, ?, ?)
      `).run(hold.user_id, hold.job_id, holdId, hold.amount, balance.balance, reason, now);
      
      return true;
    })();
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({
      trace_id: holdId, // Use holdId as trace_id
      job_id: null, // We don't have job_id directly here, could be extracted from hold if needed
      service: 'lib',
      event: 'job_failed', // Credit release affects job cleanup
      hold_id: holdId,
      reason,
      error_code: 'CREDIT_RELEASE_FAILED',
      err_name: error.constructor.name,
      err_message: error.message,
    }, `Credit release failed for hold ${holdId}: ${reason}`);
    return false;
  }
}

/** Give credits to a user (for testing/admin) */
export function giveCredits(userId: string, amount: number, reason: string = 'Manual grant'): void {
  const db = getDb();
  const now = new Date().toISOString();
  
  db.transaction(() => {
    const balance = getCreditBalance(userId);
    
    // Update balance
    db.prepare(`
      UPDATE credits SET 
        balance = balance + ?,
        total_earned = total_earned + ?,
        updated_at = ?
      WHERE user_id = ?
    `).run(amount, amount, now, userId);
    
    // Log event
    db.prepare(`
      INSERT INTO credit_events (user_id, event_type, amount, balance_after, reason, created_at)
      VALUES (?, 'earned', ?, ?, ?, ?)
    `).run(userId, amount, balance.balance + amount, reason, now);
  })();
}

// ─── API call telemetry ────────────────────────────────

/**
 * Cost per real X API call — single configurable constant.
 * Adjust to match your actual plan's per-call pricing.
 */
export const COST_PER_CALL_USD = 0.01; // $0.01 / real API call (dev estimate)

/**
 * Record one API interaction.
 * cached=false → real HTTP call to X API (counts toward totals).
 * cached=true  → request served from local cache (counts toward saved).
 * Fire-and-forget: never throws so callers are never interrupted.
 */
export function recordApiCall(endpoint: string, cached: boolean): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO api_call_log (endpoint, cached, ts) VALUES (?, ?, ?)"
    ).run(endpoint, cached ? 1 : 0, new Date().toISOString());
  } catch {
    // Non-fatal — telemetry must never break the hot path
  }
}

export interface ApiCostStats {
  calls_total: number;
  calls_last_24h: number;
  calls_by_endpoint: Record<string, number>;
  cache_saved_calls: number;
  estimated_cost_usd: number;
  cache_saved_cost_usd: number;
}

/** Aggregate API call stats from the log table. */
export function getApiCostStats(): ApiCostStats {
  const db = getDb();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const totals = db
    .prepare(
      `SELECT
         SUM(CASE WHEN cached = 0 THEN 1 ELSE 0 END) AS calls_total,
         SUM(CASE WHEN cached = 1 THEN 1 ELSE 0 END) AS cache_saved_calls
       FROM api_call_log`
    )
    .get() as { calls_total: number | null; cache_saved_calls: number | null };

  const last24h = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM api_call_log WHERE cached = 0 AND ts >= ?"
    )
    .get(since24h) as { cnt: number };

  const byEndpoint = db
    .prepare(
      "SELECT endpoint, COUNT(*) AS cnt FROM api_call_log WHERE cached = 0 GROUP BY endpoint ORDER BY cnt DESC"
    )
    .all() as Array<{ endpoint: string; cnt: number }>;

  const calls_total = totals.calls_total ?? 0;
  const cache_saved_calls = totals.cache_saved_calls ?? 0;

  return {
    calls_total,
    calls_last_24h: last24h.cnt,
    calls_by_endpoint: Object.fromEntries(
      byEndpoint.map((r) => [r.endpoint, r.cnt])
    ),
    cache_saved_calls,
    estimated_cost_usd: calls_total * COST_PER_CALL_USD,
    cache_saved_cost_usd: cache_saved_calls * COST_PER_CALL_USD,
  };
}

// ─── Dev Panel helpers ─────────────────────────────────

export interface DevUnlockEntry {
  account_id: string;
  job_id: string;
  unlocked_at: string;
  username: string | null;
  account_created_at: string | null;
  cap: number | null;
  unlocked_count: number;
}

/** List all unlocks for a given user, joined with account + job metadata. */
export function getDevUnlocks(userId: string): DevUnlockEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
         u.account_id,
         u.job_id,
         u.unlocked_at,
         a.username,
         a.created_at          AS account_created_at,
         j.requested_limit     AS cap,
         (SELECT COUNT(*) FROM tweets t WHERE t.account_id = u.account_id)
                               AS unlocked_count
       FROM unlocks u
       LEFT JOIN accounts a ON a.account_id = u.account_id
       LEFT JOIN jobs     j ON j.id          = u.job_id
       WHERE u.user_id = ?
       ORDER BY u.unlocked_at DESC`
    )
    .all(userId) as DevUnlockEntry[];
}

/** Delete one unlock record for a user+account pair. */
export function deleteDevUnlock(userId: string, accountId: string): void {
  const db = getDb();
  db.prepare(
    "DELETE FROM unlocks WHERE user_id = ? AND account_id = ?"
  ).run(userId, accountId);
}

/** Delete ALL unlock records for a user. */
export function deleteAllDevUnlocks(userId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM unlocks WHERE user_id = ?").run(userId);
}

/** Clean up expired holds */
export function cleanupExpiredHolds(): number {
  const db = getDb();
  const now = new Date().toISOString();
  
  return db.transaction(() => {
    // Find expired holds
    const expiredHolds = db.prepare(`
      SELECT * FROM credit_holds 
      WHERE status = 'held' AND expires_at < ?
    `).all(now) as CreditHold[];
    
    let cleaned = 0;
    for (const hold of expiredHolds) {
      if (releaseHeld(hold.id, 'Expired hold')) {
        cleaned++;
      }
    }
    
    return cleaned;
  })();
}
