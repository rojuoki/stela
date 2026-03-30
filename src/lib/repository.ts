/**
 * STELA repository layer — Phase 5
 * Pure DB read/write. No external API calls.
 */

import { getDb, pgQuery } from "./db";

export interface Account {
  account_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  description: string | null;
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

/** Get tweets by account with range-based pagination */
export function getTweetsByAccountRange(accountId: string, offset: number, limit: number): Tweet[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM tweets WHERE account_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?"
    )
    .all(accountId, limit, offset) as Tweet[];
}

/** Get tweets by account up to a specific boundary */
export function getTweetsByAccountUpToBoundary(accountId: string, boundaryEnd: number): Tweet[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM tweets WHERE account_id = ? ORDER BY created_at ASC LIMIT ?"
    )
    .all(accountId, boundaryEnd) as Tweet[];
}

/** Get tweets by account up to guest boundary (follows same boundary model) */
export function getTweetsByAccountForGuest(accountId: string, guestBoundary: number): Tweet[] {
  return getTweetsByAccountUpToBoundary(accountId, guestBoundary);
}

/** Count total tweets for an account */
export function getTweetCountByAccount(accountId: string): number {
  return getCachedTweetCount(accountId);
}

/** Count cached tweets for an account */
export function getCachedTweetCount(accountId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM tweets WHERE account_id = ?")
    .get(accountId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/** Get the newest cached tweet timestamp for continuation point */
export function getNewestCachedTweetTimestamp(accountId: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT MAX(created_at) as newest_created_at FROM tweets WHERE account_id = ?")
    .get(accountId) as { newest_created_at: string | null } | undefined;
  return row?.newest_created_at ?? null;
}

/** Check if user has unlocked a specific stage for an account */
export function hasUserUnlockedStage(userId: string, accountId: string, stage: number): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 FROM unlocks WHERE user_id = ? AND account_id = ? AND stage = ?")
    .get(userId, accountId, stage);
  return !!row;
}

/** Get the highest stage unlocked by a user for an account (returns 0 if none) */
export function getUserHighestUnlockedStage(userId: string, accountId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT MAX(stage) as max_stage FROM unlocks WHERE user_id = ? AND account_id = ?")
    .get(userId, accountId) as { max_stage: number | null } | undefined;
  return row?.max_stage ?? 0;
}

/** Get user's current visibility boundary for an account (new boundary model) */
export function getUserBoundaryEnd(userId: string, accountId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT MAX(boundary_end) as max_boundary FROM unlocks WHERE user_id = ? AND account_id = ?")
    .get(userId, accountId) as { max_boundary: number | null } | undefined;
  return row?.max_boundary ?? 0;
}

/** Get user's total unlocked count for an account (sum of all granted_count) */
export function getUserTotalUnlockedCount(userId: string, accountId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT SUM(granted_count) as total_granted FROM unlocks WHERE user_id = ? AND account_id = ?")
    .get(userId, accountId) as { total_granted: number | null } | undefined;
  return row?.total_granted ?? 0;
}

/** Check if user already unlocked this account (boundary-based visibility check) */
export function hasUserUnlockedAccount(userId: string, accountId: string): boolean {
  return getUserBoundaryEnd(userId, accountId) > 0;
}

/** Record stage unlock with boundary data (idempotent via UNIQUE constraint) */
export function recordStageUnlock(
  userId: string, 
  accountId: string, 
  stage: number, 
  boundaryEnd: number,
  grantedCount: number,
  jobId: string
): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO unlocks (user_id, account_id, stage, boundary_end, granted_count, job_id, unlocked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, accountId, stage, boundaryEnd, grantedCount, jobId, new Date().toISOString());
}

/** Record unlock (backward compatibility - records Stage 1 unlock) */
export function recordUnlock(userId: string, accountId: string, jobId: string): void {
  // For backward compatibility, we need to calculate boundary_end and granted_count
  // This is a transitional function - new code should use recordStageUnlock directly
  const tweetCount = getCachedTweetCount(accountId);
  const boundaryEnd = Math.min(100, tweetCount); // Stage 1 default boundary
  recordStageUnlock(userId, accountId, 1, boundaryEnd, boundaryEnd, jobId);
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
    console.error('[credits] Hold failed:', e);
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
    console.error('[credits] spendCredits failed:', e);
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
    console.error('[credits] Capture failed:', e);
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
    console.error('[credits] Release failed:', e);
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

// ─── Subscription System (Phase 1) ─────────────────────────────────

export interface Subscription {
  id: string;
  user_id: string;
  plan: string;
  cycle_start: string;
  cycle_end: string;
  credits_per_cycle: number;
  status: 'active' | 'canceled' | 'expired';
  created_at: string;
}

/** Get user's current subscription (null if free user) */
export function getUserSubscription(userId: string): Subscription | null {
  const db = getDb();
  const subscription = db
    .prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'")
    .get(userId) as Subscription | undefined;
  
  return subscription || null;
}

/** Get effective user plan (free/basic) */
export function getUserPlan(userId: string): 'free' | 'basic' {
  const subscription = getUserSubscription(userId);
  
  if (!subscription) {
    return 'free';
  }
  
  // Check if subscription is still valid
  const now = new Date();
  const cycleEnd = new Date(subscription.cycle_end);
  
  if (cycleEnd < now) {
    // Expired subscription - should be marked as expired
    return 'free';
  }
  
  return subscription.plan === 'basic' ? 'basic' : 'free';
}

/** Create or update a subscription for a user */
export function createOrUpdateSubscription(
  userId: string, 
  plan: 'basic' = 'basic',
  creditsPerCycle: number = 4
): Subscription {
  const db = getDb();
  const now = new Date();
  const cycleStart = now.toISOString();
  const cycleEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  const subscriptionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  
  return db.transaction(() => {
    // Cancel any existing active subscriptions
    db.prepare(`
      UPDATE subscriptions SET status = 'canceled' 
      WHERE user_id = ? AND status = 'active'
    `).run(userId);
    
    // Create new subscription
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, plan, cycle_start, cycle_end, credits_per_cycle, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(subscriptionId, userId, plan, cycleStart, cycleEnd, creditsPerCycle, now.toISOString());
    
    // Grant initial cycle credits
    giveCredits(userId, creditsPerCycle, `${plan} subscription activated`);
    
    return {
      id: subscriptionId,
      user_id: userId,
      plan,
      cycle_start: cycleStart,
      cycle_end: cycleEnd,
      credits_per_cycle: creditsPerCycle,
      status: 'active' as const,
      created_at: now.toISOString(),
    };
  })();
}

/** Check if user has sufficient entitlement to unlock (credits OR active subscription) */
export function canUserUnlock(userId: string): {
  canUnlock: boolean;
  reason: 'credits' | 'subscription' | 'insufficient';
  credits: number;
  plan: 'free' | 'basic';
} {
  const credits = getCreditBalance(userId).balance;
  const plan = getUserPlan(userId);
  
  // Users can unlock if they have credits OR active subscription
  if (credits > 0) {
    return { canUnlock: true, reason: 'credits', credits, plan };
  }
  
  if (plan === 'basic') {
    return { canUnlock: true, reason: 'subscription', credits, plan };
  }
  
  return { canUnlock: false, reason: 'insufficient', credits, plan };
}

/** 
 * Grant monthly subscription credits (placeholder for cron job)
 * This will be called by a scheduled task to grant monthly credits
 * to active Basic subscribers
 */
export function grantMonthlyCredits(): { processed: number; granted: number } {
  const db = getDb();
  const now = new Date();
  
  // Find active subscriptions that need credit refresh
  const subscriptions = db.prepare(`
    SELECT * FROM subscriptions 
    WHERE status = 'active' 
      AND cycle_end <= ?
      AND plan = 'basic'
  `).all(now.toISOString()) as Subscription[];
  
  let processed = 0;
  let granted = 0;
  
  for (const subscription of subscriptions) {
    processed++;
    
    try {
      db.transaction(() => {
        // Extend cycle
        const newCycleStart = now.toISOString();
        const newCycleEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        
        db.prepare(`
          UPDATE subscriptions 
          SET cycle_start = ?, cycle_end = ?
          WHERE id = ?
        `).run(newCycleStart, newCycleEnd, subscription.id);
        
        // Grant monthly credits
        giveCredits(subscription.user_id, subscription.credits_per_cycle, 
                   `Monthly ${subscription.plan} subscription grant`);
        
        granted += subscription.credits_per_cycle;
      })();
    } catch (error) {
      console.error(`[subscription] Failed to grant credits to ${subscription.user_id}:`, error);
    }
  }
  
  console.log(`[subscription] Granted monthly credits: ${processed} subscriptions processed, ${granted} credits granted`);
  return { processed, granted };
}

// ─── User unlocks (grouped by account) ────────────────

export interface UnlockedAccountEntry {
  account_id: string;
  username: string | null;
  account_created_at: string | null;
  boundary_end: number;
  unlocked_at: string;
}

/** One card per account: latest state across all unlock stages. */
export function getUserUnlockedAccounts(userId: string): UnlockedAccountEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
         u.account_id,
         a.username,
         a.created_at               AS account_created_at,
         MAX(u.boundary_end)        AS boundary_end,
         MAX(u.unlocked_at)         AS unlocked_at
       FROM unlocks u
       LEFT JOIN accounts a ON a.account_id = u.account_id
       WHERE u.user_id = ?
       GROUP BY u.account_id
       ORDER BY MAX(u.unlocked_at) DESC`
    )
    .all(userId) as UnlockedAccountEntry[];
}

// ─── Dev Panel helpers ─────────────────────────────────

export interface DevUnlockEntry {
  account_id: string;
  stage: number;
  boundary_end: number;
  granted_count: number;
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
         u.stage,
         u.boundary_end,
         u.granted_count,
         u.job_id,
         u.unlocked_at,
         a.username,
         a.created_at          AS account_created_at,
         j.requested_limit     AS cap,
         u.boundary_end        AS unlocked_count
       FROM unlocks u
       LEFT JOIN accounts a ON a.account_id = u.account_id
       LEFT JOIN jobs     j ON j.id          = u.job_id
       WHERE u.user_id = ?
       ORDER BY u.unlocked_at DESC, u.stage ASC`
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

// ─── Temporary Unlocks (Phase 2) ───────────────────────────────

export interface TemporaryUnlock {
  token: string;
  account_id: string;
  username: string;
  tweets_json: string;
  job_id: string | null;
  created_at: string;
  expires_at: string;
  consumed: number;
}

/** Create a temporary unlock result for guest users */
export function createTemporaryUnlock(accountId: string, username: string, tweets: any[], jobId?: string | null): string {
  const db = getDb();
  const token = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48 hours TTL
  
  db.prepare(`
    INSERT INTO temporary_unlocks (token, account_id, username, tweets_json, job_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    token,
    accountId,
    username.toLowerCase(),
    JSON.stringify(tweets),
    jobId || null,
    now.toISOString(),
    expiresAt.toISOString()
  );
  
  console.log(`[temporary-unlock] Created token ${token} for @${username}${jobId ? ` (job: ${jobId})` : ''} (expires: ${expiresAt.toISOString()})`);
  return token;
}

/** Get temporary unlock by token */
export function getTemporaryUnlock(token: string): TemporaryUnlock | null {
  const db = getDb();
  const now = new Date().toISOString();
  
  const result = db.prepare(`
    SELECT * FROM temporary_unlocks 
    WHERE token = ? AND expires_at > ? AND consumed = 0
  `).get(token, now) as TemporaryUnlock | undefined;
  
  return result || null;
}

/** Transfer temporary unlock to user account (on account creation) */
export function transferTemporaryUnlock(token: string, userId: string): boolean {
  const db = getDb();
  
  return db.transaction(() => {
    const tempUnlock = getTemporaryUnlock(token);
    if (!tempUnlock) {
      return false;
    }
    
    // Mark temporary unlock as consumed
    db.prepare(`
      UPDATE temporary_unlocks SET consumed = 1 WHERE token = ?
    `).run(token);
    
    // Create official unlock record
    recordUnlock(userId, tempUnlock.account_id, `temp-transfer-${token}`);
    
    console.log(`[temporary-unlock] Transferred token ${token} to user ${userId} for account ${tempUnlock.account_id}`);
    return true;
  })();
}

/** Clean up expired temporary unlocks */
export function cleanupExpiredTemporaryUnlocks(): number {
  const db = getDb();
  const now = new Date().toISOString();
  
  const result = db.prepare(`
    DELETE FROM temporary_unlocks 
    WHERE expires_at < ?
  `).run(now);
  
  if (result.changes > 0) {
    console.log(`[temporary-unlock] Cleaned up ${result.changes} expired temporary unlocks`);
  }
  
  return result.changes;
}

// ========================================
// POSTGRES REPOSITORY FUNCTIONS (Phase 3.2)
// Async versions for gradual migration from SQLite
// ========================================

/**
 * Postgres version of getAccountByUsername.
 * Returns Account or undefined, with boolean converted from integer.
 */
export async function getAccountByUsernamePg(username: string): Promise<Account | undefined> {
  try {
    const result = await pgQuery(
      "SELECT * FROM accounts WHERE username = $1",
      [username.toLowerCase()]
    );
    
    if (result.rows.length === 0) {
      return undefined;
    }
    
    const row = result.rows[0];
    return {
      account_id: row.account_id,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      description: row.description,
      created_at: row.created_at,
      protected: row.protected ? 1 : 0, // Convert boolean back to integer for compatibility
      fetched_at: row.fetched_at,
    };
  } catch (error) {
    console.error("[repository] getAccountByUsernamePg error:", error);
    throw error;
  }
}

/**
 * Postgres version of recordApiCall.
 * Non-fatal telemetry logging.
 */
export async function recordApiCallPg(endpoint: string, cached: boolean): Promise<void> {
  try {
    await pgQuery(
      "INSERT INTO api_call_log (endpoint, cached, ts) VALUES ($1, $2, $3)",
      [endpoint, cached, new Date().toISOString()]
    );
  } catch (error) {
    // Non-fatal — telemetry must never break the hot path
    console.warn("[repository] recordApiCallPg failed:", error);
  }
}

/**
 * Create or update account in Postgres.
 * Handles the INSERT OR REPLACE logic that was directly in /api/account route.
 */
export async function createOrUpdateAccountPg(accountData: {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
  description?: string;
  created_at: string;
  protected: boolean;
}): Promise<void> {
  try {
    await pgQuery(
      `INSERT INTO accounts (account_id, username, display_name, avatar_url, description, created_at, protected, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (account_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url,
         description = EXCLUDED.description,
         protected = EXCLUDED.protected,
         fetched_at = EXCLUDED.fetched_at`,
      [
        accountData.id,
        accountData.username.toLowerCase(),
        accountData.name,
        accountData.profile_image_url || null,
        accountData.description || null,
        accountData.created_at,
        accountData.protected,
        new Date().toISOString()
      ]
    );
  } catch (error) {
    console.error("[repository] createOrUpdateAccountPg error:", error);
    throw error;
  }
}

/**
 * Postgres health check.
 * Simple connectivity test for database health monitoring.
 */
export async function getDatabaseHealthPg(): Promise<{ healthy: boolean; dbValue: number }> {
  try {
    const result = await pgQuery("SELECT 1 as test");
    return {
      healthy: true,
      dbValue: result.rows[0]?.test || 0
    };
  } catch (error) {
    console.error("[repository] getDatabaseHealthPg error:", error);
    throw error;
  }
}

/**
 * Check if user already unlocked this account (Postgres version).
 */
export async function hasUserUnlockedAccountPg(userId: string, accountId: string): Promise<boolean> {
  try {
    const result = await pgQuery(
      "SELECT MAX(boundary_end) as max_boundary FROM unlocks WHERE user_id = $1 AND account_id = $2",
      [userId, accountId]
    );
    return (result.rows[0]?.max_boundary || 0) > 0;
  } catch (error) {
    console.error("[repository] hasUserUnlockedAccountPg error:", error);
    throw error;
  }
}

/**
 * Get temporary unlock by token (Postgres version).
 */
export async function getTemporaryUnlockPg(token: string): Promise<TemporaryUnlock | null> {
  try {
    const result = await pgQuery(
      "SELECT * FROM temporary_unlocks WHERE token = $1 AND expires_at > NOW() AND consumed = false",
      [token]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      token: row.token,
      account_id: row.account_id,
      username: row.username,
      tweets_json: row.tweets_json,
      job_id: row.job_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      consumed: row.consumed ? 1 : 0 // Convert boolean back to number for compatibility
    };
  } catch (error) {
    console.error("[repository] getTemporaryUnlockPg error:", error);
    throw error;
  }
}

/**
 * Transfer temporary unlock to user account (Postgres version).
 */
export async function transferTemporaryUnlockPg(token: string, userId: string): Promise<boolean> {
  try {
    // Start transaction simulation with multiple queries
    const tempUnlock = await getTemporaryUnlockPg(token);
    if (!tempUnlock) {
      return false;
    }
    
    // Mark temporary unlock as consumed
    await pgQuery(
      "UPDATE temporary_unlocks SET consumed = true WHERE token = $1",
      [token]
    );
    
    // Create official unlock record (using boundary defaults for now)
    await pgQuery(
      `INSERT INTO unlocks (user_id, account_id, stage, boundary_end, granted_count, job_id, unlocked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, account_id, stage) DO NOTHING`,
      [userId, tempUnlock.account_id, 1, 100, 100, `temp-transfer-${token}`]
    );
    
    console.log(`[temporary-unlock] Transferred token ${token} to user ${userId} for account ${tempUnlock.account_id}`);
    return true;
  } catch (error) {
    console.error("[repository] transferTemporaryUnlockPg error:", error);
    throw error;
  }
}

/**
 * Get checkout session by session ID (Postgres version).
 * Used by guest unlock token retrieval.
 */
export async function getCheckoutSessionPg(sessionId: string): Promise<{ unlock_token: string, username: string } | null> {
  try {
    const result = await pgQuery(
      "SELECT unlock_token, username FROM checkout_sessions WHERE session_id = $1 AND expires_at > NOW()",
      [sessionId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      unlock_token: row.unlock_token,
      username: row.username
    };
  } catch (error) {
    console.error("[repository] getCheckoutSessionPg error:", error);
    throw error;
  }
}

export interface JobRow {
  id: string;
  account_username: string;
  status: string;
  resume_at: string | null;
  api_calls: number;
  fetched_count: number;
  requested_limit: number;
  created_at: string;
  started_at: string | null;
}

/**
 * Get active jobs from database with proper ordering (Postgres version).
 * Used by dev jobs panel.
 */
export async function getActiveJobsPg(): Promise<JobRow[]> {
  try {
    const result = await pgQuery(
      `SELECT id, account_username, status, resume_at, api_calls, fetched_count,
              requested_limit, created_at, started_at
       FROM jobs
       WHERE status IN ('running', 'queued')
       ORDER BY
         CASE
           WHEN status = 'running' THEN 0
           WHEN status = 'queued' AND (resume_at IS NULL OR resume_at <= NOW()) THEN 1
           ELSE 2
         END,
         created_at ASC`
    );
    
    return result.rows.map(row => ({
      id: row.id,
      account_username: row.account_username,
      status: row.status,
      resume_at: row.resume_at,
      api_calls: row.api_calls,
      fetched_count: row.fetched_count,
      requested_limit: row.requested_limit,
      created_at: row.created_at,
      started_at: row.started_at
    }));
  } catch (error) {
    console.error("[repository] getActiveJobsPg error:", error);
    throw error;
  }
}

// ========================================
// AUTH FUNCTIONS (Postgres versions)
// ========================================

export interface User {
  id: string;
  email: string;
  name: string;
}

/**
 * Create user in Postgres.
 */
export async function createUserPg(email: string, passwordHash: string, name: string): Promise<User | null> {
  try {
    const normalizedEmail = email.toLowerCase();
    
    // Check if user exists
    const existing = await pgQuery(
      "SELECT id FROM users WHERE email = $1",
      [normalizedEmail]
    );
    
    if (existing.rows.length > 0) {
      return null; // User already exists
    }
    
    // Create new user
    const id = `user_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await pgQuery(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, NOW())",
      [id, normalizedEmail, name, passwordHash]
    );
    
    return { id, email: normalizedEmail, name };
  } catch (error) {
    console.error("[repository] createUserPg error:", error);
    throw error;
  }
}

/**
 * Authenticate user in Postgres.
 */
export async function authenticateUserPg(email: string): Promise<{ id: string; email: string; name: string; password_hash: string } | null> {
  try {
    const result = await pgQuery(
      "SELECT id, email, name, password_hash FROM users WHERE email = $1",
      [email.toLowerCase()]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      password_hash: row.password_hash
    };
  } catch (error) {
    console.error("[repository] authenticateUserPg error:", error);
    throw error;
  }
}

// ========================================
// CREDIT SYSTEM (Postgres versions)
// ========================================

export interface CreditBalance {
  user_id: string;
  balance: number;
  total_earned: number;
  total_spent: number;
  updated_at: string;
}

/**
 * Get credit balance for a user (Postgres version).
 */
export async function getCreditBalancePg(userId: string): Promise<CreditBalance> {
  try {
    const result = await pgQuery(
      "SELECT * FROM credits WHERE user_id = $1",
      [userId]
    );
    
    if (result.rows.length === 0) {
      // Create default balance
      const now = new Date().toISOString();
      await pgQuery(
        "INSERT INTO credits (user_id, balance, total_earned, total_spent, updated_at) VALUES ($1, 0, 0, 0, NOW())",
        [userId]
      );
      
      return {
        user_id: userId,
        balance: 0,
        total_earned: 0,
        total_spent: 0,
        updated_at: now,
      };
    }
    
    const row = result.rows[0];
    return {
      user_id: row.user_id,
      balance: row.balance,
      total_earned: row.total_earned,
      total_spent: row.total_spent,
      updated_at: row.updated_at,
    };
  } catch (error) {
    console.error("[repository] getCreditBalancePg error:", error);
    throw error;
  }
}

/**
 * Give credits to user (Postgres version).
 */
export async function giveCreditsPg(userId: string, amount: number, reason: string): Promise<void> {
  try {
    const balance = await getCreditBalancePg(userId);
    const newBalance = balance.balance + amount;
    
    // Update balance
    await pgQuery(
      "UPDATE credits SET balance = $1, total_earned = total_earned + $2, updated_at = NOW() WHERE user_id = $3",
      [newBalance, amount, userId]
    );
    
    // Log event
    await pgQuery(
      "INSERT INTO credit_events (user_id, event_type, amount, balance_after, reason, created_at) VALUES ($1, 'earned', $2, $3, $4, NOW())",
      [userId, amount, newBalance, reason]
    );
  } catch (error) {
    console.error("[repository] giveCreditsPg error:", error);
    throw error;
  }
}

/**
 * Spend credits immediately (Postgres version).
 */
export async function spendCreditsPg(userId: string, amount: number, reason: string): Promise<boolean> {
  try {
    const balance = await getCreditBalancePg(userId);
    if (balance.balance < amount) {
      return false;
    }
    
    const newBalance = balance.balance - amount;
    
    // Update balance
    await pgQuery(
      "UPDATE credits SET balance = $1, total_spent = total_spent + $2, updated_at = NOW() WHERE user_id = $3",
      [newBalance, amount, userId]
    );
    
    // Log event
    await pgQuery(
      "INSERT INTO credit_events (user_id, event_type, amount, balance_after, reason, created_at) VALUES ($1, 'captured', $2, $3, $4, NOW())",
      [userId, amount, newBalance, reason]
    );
    
    return true;
  } catch (error) {
    console.error("[repository] spendCreditsPg error:", error);
    return false;
  }
}

/**
 * Hold credits for a job (Postgres version).
 */
export async function holdCreditsPg(userId: string, jobId: string, amount: number = 1): Promise<string | null> {
  try {
    const balance = await getCreditBalancePg(userId);
    if (balance.balance < amount) {
      return null;
    }
    
    const holdId = `hold_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes TTL
    
    // Create hold and update balance in transaction-like manner
    await pgQuery(
      "INSERT INTO credit_holds (id, user_id, job_id, amount, created_at, expires_at, status) VALUES ($1, $2, $3, $4, NOW(), $5, 'held')",
      [holdId, userId, jobId, amount, expiresAt.toISOString()]
    );
    
    // Update balance
    await pgQuery(
      "UPDATE credits SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2",
      [amount, userId]
    );
    
    // Log event
    await pgQuery(
      "INSERT INTO credit_events (user_id, job_id, hold_id, event_type, amount, balance_after, reason, created_at) VALUES ($1, $2, $3, 'held', $4, $5, $6, NOW())",
      [userId, jobId, holdId, amount, balance.balance - amount, `Hold for job ${jobId}`]
    );
    
    return holdId;
  } catch (error) {
    console.error("[repository] holdCreditsPg error:", error);
    return null;
  }
}

/**
 * Capture held credits (Postgres version).
 */
export async function captureHeldPg(holdId: string, reason: string = "Unlock successful"): Promise<boolean> {
  try {
    // Get hold
    const holdResult = await pgQuery(
      "SELECT * FROM credit_holds WHERE id = $1 AND status = 'held'",
      [holdId]
    );
    
    if (holdResult.rows.length === 0) {
      return false;
    }
    
    const hold = holdResult.rows[0];
    
    // Mark as captured
    await pgQuery(
      "UPDATE credit_holds SET status = 'captured' WHERE id = $1",
      [holdId]
    );
    
    // Update total spent
    await pgQuery(
      "UPDATE credits SET total_spent = total_spent + $1, updated_at = NOW() WHERE user_id = $2",
      [hold.amount, hold.user_id]
    );
    
    // Log event
    const balance = await getCreditBalancePg(hold.user_id);
    await pgQuery(
      "INSERT INTO credit_events (user_id, job_id, hold_id, event_type, amount, balance_after, reason, created_at) VALUES ($1, $2, $3, 'captured', $4, $5, $6, NOW())",
      [hold.user_id, hold.job_id, holdId, hold.amount, balance.balance, reason]
    );
    
    return true;
  } catch (error) {
    console.error("[repository] captureHeldPg error:", error);
    return false;
  }
}

// ========================================
// UNLOCK SYSTEM (Postgres versions)
// ========================================

/**
 * Get cached tweet count for an account (Postgres version).
 */
export async function getCachedTweetCountPg(accountId: string): Promise<number> {
  try {
    const result = await pgQuery(
      "SELECT COUNT(*) as cnt FROM tweets WHERE account_id = $1",
      [accountId]
    );
    return result.rows[0]?.cnt || 0;
  } catch (error) {
    console.error("[repository] getCachedTweetCountPg error:", error);
    throw error;
  }
}

/**
 * Check if user has unlocked a specific stage (Postgres version).
 */
export async function hasUserUnlockedStagePg(userId: string, accountId: string, stage: number): Promise<boolean> {
  try {
    const result = await pgQuery(
      "SELECT 1 FROM unlocks WHERE user_id = $1 AND account_id = $2 AND stage = $3",
      [userId, accountId, stage]
    );
    return result.rows.length > 0;
  } catch (error) {
    console.error("[repository] hasUserUnlockedStagePg error:", error);
    throw error;
  }
}

/**
 * Record stage unlock (Postgres version).
 */
export async function recordStageUnlockPg(
  userId: string, 
  accountId: string, 
  stage: number, 
  boundaryEnd: number,
  grantedCount: number,
  jobId: string
): Promise<void> {
  try {
    await pgQuery(
      `INSERT INTO unlocks (user_id, account_id, stage, boundary_end, granted_count, job_id, unlocked_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, account_id, stage) DO NOTHING`,
      [userId, accountId, stage, boundaryEnd, grantedCount, jobId]
    );
  } catch (error) {
    console.error("[repository] recordStageUnlockPg error:", error);
    throw error;
  }
}

/**
 * Record basic unlock (backward compatibility) (Postgres version).
 */
export async function recordUnlockPg(userId: string, accountId: string, jobId: string): Promise<void> {
  try {
    const tweetCount = await getCachedTweetCountPg(accountId);
    const boundaryEnd = Math.min(100, tweetCount);
    await recordStageUnlockPg(userId, accountId, 1, boundaryEnd, boundaryEnd, jobId);
  } catch (error) {
    console.error("[repository] recordUnlockPg error:", error);
    throw error;
  }
}

/**
 * Find active job for username (Postgres version).
 */
export async function findActiveJobForUsernamePg(username: string): Promise<string | null> {
  try {
    const result = await pgQuery(
      "SELECT id FROM jobs WHERE account_username = $1 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
      [username.toLowerCase()]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  } catch (error) {
    console.error("[repository] findActiveJobForUsernamePg error:", error);
    throw error;
  }
}

/**
 * Cleanup expired holds (Postgres version).
 */
export async function cleanupExpiredHoldsPg(): Promise<void> {
  try {
    // Release expired holds and return credits
    const expiredHolds = await pgQuery(
      "SELECT * FROM credit_holds WHERE status = 'held' AND expires_at <= NOW()"
    );
    
    for (const hold of expiredHolds.rows) {
      // Mark as released
      await pgQuery(
        "UPDATE credit_holds SET status = 'released' WHERE id = $1",
        [hold.id]
      );
      
      // Return credits
      await pgQuery(
        "UPDATE credits SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2",
        [hold.amount, hold.user_id]
      );
      
      // Log event
      const balance = await getCreditBalancePg(hold.user_id);
      await pgQuery(
        "INSERT INTO credit_events (user_id, job_id, hold_id, event_type, amount, balance_after, reason, created_at) VALUES ($1, $2, $3, 'expired', $4, $5, 'Hold expired', NOW())",
        [hold.user_id, hold.job_id, hold.id, hold.amount, balance.balance]
      );
    }
  } catch (error) {
    console.error("[repository] cleanupExpiredHoldsPg error:", error);
    // Non-fatal for cleanup function
  }
}
