/**
 * STELA repository layer — Phase 5
 * Pure DB read/write. No external API calls.
 */

import { pgQuery } from "./db";

// Mock infrastructure removed - all functions now use PostgreSQL

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

export async function getAccountByUsername(username: string): Promise<Account | undefined> {
  const result = await pgQuery(
    "SELECT * FROM accounts WHERE username = $1",
    [username.toLowerCase()]
  );
  if (result.rows.length === 0) return undefined;
  return result.rows[0] as Account;
}

export async function getTweetsByAccount(accountId: string): Promise<Tweet[]> {
  const result = await pgQuery(
    "SELECT * FROM tweets WHERE account_id = $1 ORDER BY created_at ASC LIMIT 100",
    [accountId]
  );
  return result.rows as Tweet[];
}

/** Get tweets by account with range-based pagination */
export async function getTweetsByAccountRange(accountId: string, offset: number, limit: number): Promise<Tweet[]> {
  const result = await pgQuery(
    "SELECT * FROM tweets WHERE account_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3",
    [accountId, limit, offset]
  );
  return result.rows as Tweet[];
}

/** Get tweets by account up to a specific boundary */
export async function getTweetsByAccountUpToBoundary(accountId: string, boundaryEnd: number): Promise<Tweet[]> {
  const result = await pgQuery(
    "SELECT * FROM tweets WHERE account_id = $1 ORDER BY created_at ASC LIMIT $2",
    [accountId, boundaryEnd]
  );
  return result.rows as Tweet[];
}

/** Get tweets by account up to guest boundary (follows same boundary model) */
export async function getTweetsByAccountForGuest(accountId: string, guestBoundary: number): Promise<Tweet[]> {
  return await getTweetsByAccountUpToBoundary(accountId, guestBoundary);
}

/** Count total tweets for an account */
export async function getTweetCountByAccount(accountId: string): Promise<number> {
  return await getCachedTweetCount(accountId);
}

/** Count cached tweets for an account */
export async function getCachedTweetCount(accountId: string): Promise<number> {
  const result = await pgQuery("SELECT COUNT(*) as cnt FROM tweets WHERE account_id = $1", [accountId]);
  if (result.rows.length === 0) return 0;
  return parseInt(result.rows[0].cnt);
}

/** Get the newest cached tweet timestamp for continuation point */
export async function getNewestCachedTweetTimestamp(accountId: string): Promise<string | null> {
  const result = await pgQuery("SELECT MAX(created_at) as newest_created_at FROM tweets WHERE account_id = $1", [accountId]);
  if (result.rows.length === 0) return null;
  return result.rows[0].newest_created_at ?? null;
}

/**
 * Check if user has unlocked up to at least a given boundary for an account.
 * Replaces hasUserUnlockedStage: stage N ≈ boundary >= N*100.
 */
export async function hasUserUnlockedStage(userId: string, accountId: string, stage: number): Promise<boolean> {
  const boundary = await getUserBoundaryEndPg(userId, accountId);
  return boundary >= stage * 100;
}

/* REMOVED: getUserHighestUnlockedStage — no longer needed (use boundary directly) */
/* REMOVED: getUserBoundaryEnd — replaced with getUserBoundaryEndPg */
/* REMOVED: getUserTotalUnlockedCount — granted_count column removed */

/** Check if user already unlocked this account (boundary-based visibility check) */
export async function hasUserUnlockedAccount(userId: string, accountId: string): Promise<boolean> {
  return (await getUserBoundaryEndPg(userId, accountId)) > 0;
}

/** @deprecated Use upsertUnlockBoundary from unlockWrite.ts instead */
export async function recordStageUnlock(): Promise<void> {
  throw new Error("recordStageUnlock is removed — use upsertUnlockBoundary");
}

/** @deprecated Use upsertUnlockBoundary from unlockWrite.ts instead */
export async function recordUnlock(): Promise<void> {
  throw new Error("recordUnlock is removed — use upsertUnlockBoundary");
}

/**
 * Find an active (queued/running) job for a given username.
 * Used to collapse concurrent unlock requests into one job.
 */
export async function findActiveJobForUsername(username: string): Promise<string | null> {
  const result = await pgQuery(
    "SELECT id FROM jobs WHERE account_username = $1 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
    [username.toLowerCase()]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].id;
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
export async function getCreditBalance(userId: string): Promise<CreditBalance> {
  let result = await pgQuery("SELECT * FROM credits WHERE user_id = $1", [userId]);
  
  if (result.rows.length === 0) {
    const now = new Date().toISOString();
    await pgQuery(`
      INSERT INTO credits (user_id, balance, total_earned, total_spent, updated_at)
      VALUES ($1, 0, 0, 0, $2)
    `, [userId, now]);
    
    return {
      user_id: userId,
      balance: 0,
      total_earned: 0,
      total_spent: 0,
      updated_at: now,
    };
  }
  
  return result.rows[0] as CreditBalance;
}

/** Hold credits for a job (returns hold ID or null if insufficient balance) */
export async function holdCredits(userId: string, jobId: string, amount: number = 1): Promise<string | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes TTL
  const holdId = `hold_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  try {
    // Check balance
    const balance = await getCreditBalance(userId);
    if (balance.balance < amount) {
      return null; // Insufficient balance
    }
    
    // Create hold
    await pgQuery(`
      INSERT INTO credit_holds (id, user_id, job_id, amount, created_at, expires_at, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'held')
    `, [holdId, userId, jobId, amount, now.toISOString(), expiresAt.toISOString()]);
    
    // Update balance (deduct held amount)
    await pgQuery(`
      UPDATE credits SET balance = balance - $1, updated_at = $2
      WHERE user_id = $3
    `, [amount, now.toISOString(), userId]);
    
    // Log event
    await pgQuery(`
      INSERT INTO credit_events (user_id, job_id, hold_id, event_type, amount, balance_after, reason, created_at)
      VALUES ($1, $2, $3, 'held', $4, $5, $6, $7)
    `, [userId, jobId, holdId, amount, balance.balance - amount, `Hold for job ${jobId}`, now.toISOString()]);
    
    return holdId;
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
export async function spendCredits(userId: string, amount: number, reason: string): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    const balance = await getCreditBalance(userId);
    if (balance.balance < amount) return false;

    await pgQuery(`UPDATE credits SET balance = balance - $1, total_spent = total_spent + $2, updated_at = $3 WHERE user_id = $4`, 
      [amount, amount, now, userId]);

    await pgQuery(`
      INSERT INTO credit_events (user_id, event_type, amount, balance_after, reason, created_at)
      VALUES ($1, 'captured', $2, $3, $4, $5)
    `, [userId, amount, balance.balance - amount, reason, now]);

    return true;
  } catch (e) {
    console.error('[credits] spendCredits failed:', e);
    return false;
  }
}

/** Capture held credits (consume them on successful unlock) */
export async function captureHeld(holdId: string, reason: string = 'Unlock successful'): Promise<boolean> {
  const now = new Date().toISOString();
  
  try {
    // Get hold
    const holdResult = await pgQuery("SELECT * FROM credit_holds WHERE id = $1 AND status = 'held'", [holdId]);
    
    if (holdResult.rows.length === 0) {
      return false; // Hold not found or already processed
    }
    
    const hold = holdResult.rows[0] as CreditHold;
    
    // Mark as captured
    await pgQuery("UPDATE credit_holds SET status = 'captured' WHERE id = $1", [holdId]);
    
    // Update totals
    await pgQuery(`
      UPDATE credits SET total_spent = total_spent + $1, updated_at = $2
      WHERE user_id = $3
    `, [hold.amount, now, hold.user_id]);
    
    // Log event
    const balance = await getCreditBalance(hold.user_id);
    await pgQuery(`
      INSERT INTO credit_events (user_id, job_id, hold_id, event_type, amount, balance_after, reason, created_at)
      VALUES ($1, $2, $3, 'captured', $4, $5, $6, $7)
    `, [hold.user_id, hold.job_id, holdId, hold.amount, balance.balance, reason, now]);
    
    return true;
  } catch (e) {
    console.error('[credits] Capture failed:', e);
    return false;
  }
}

/** Release held credits (return them on failure/0 posts) */
export async function releaseHeld(holdId: string, reason: string = 'Unlock failed'): Promise<boolean> {
  const now = new Date().toISOString();
  
  try {
    // Get hold
    const holdResult = await pgQuery("SELECT * FROM credit_holds WHERE id = $1 AND status = 'held'", [holdId]);
    
    if (holdResult.rows.length === 0) {
      return false; // Hold not found or already processed
    }
    
    const hold = holdResult.rows[0] as CreditHold;
    
    // Mark as released
    await pgQuery("UPDATE credit_holds SET status = 'released' WHERE id = $1", [holdId]);
    
    // Return credits to balance
    await pgQuery(`
      UPDATE credits SET balance = balance + $1, updated_at = $2
      WHERE user_id = $3
    `, [hold.amount, now, hold.user_id]);
    
    // Log event
    const balance = await getCreditBalance(hold.user_id);
    await pgQuery(`
      INSERT INTO credit_events (user_id, job_id, hold_id, event_type, amount, balance_after, reason, created_at)
      VALUES ($1, $2, $3, 'released', $4, $5, $6, $7)
    `, [hold.user_id, hold.job_id, holdId, hold.amount, balance.balance, reason, now]);
    
    return true;
  } catch (e) {
    console.error('[credits] Release failed:', e);
    return false;
  }
}

/* REMOVED: giveCredits - replaced with giveCreditsPg */

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
export async function recordApiCall(endpoint: string, cached: boolean): Promise<void> {
  try {
    await pgQuery(
      "INSERT INTO api_call_log (endpoint, cached, ts) VALUES ($1, $2, $3)",
      [endpoint, cached ? 1 : 0, new Date().toISOString()]
    );
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

/** Aggregate API call stats from the log table (Postgres version). */
export async function getApiCostStats(): Promise<ApiCostStats> {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Get total API calls (cached=false)
    const totalsResult = await pgQuery(`
      SELECT
        SUM(CASE WHEN cached = false THEN 1 ELSE 0 END) AS calls_total,
        SUM(CASE WHEN cached = true THEN 1 ELSE 0 END) AS cache_saved_calls
      FROM api_call_log
    `);

    // Get last 24h API calls
    const last24hResult = await pgQuery(`
      SELECT COUNT(*) AS cnt 
      FROM api_call_log 
      WHERE cached = false AND ts >= $1
    `, [since24h]);

    // Get calls by endpoint
    const byEndpointResult = await pgQuery(`
      SELECT endpoint, COUNT(*) AS cnt 
      FROM api_call_log 
      WHERE cached = false 
      GROUP BY endpoint 
      ORDER BY cnt DESC
    `);

    const calls_total = totalsResult.rows[0]?.calls_total || 0;
    const cache_saved_calls = totalsResult.rows[0]?.cache_saved_calls || 0;
    const calls_last_24h = last24hResult.rows[0]?.cnt || 0;

    const calls_by_endpoint: Record<string, number> = {};
    for (const row of byEndpointResult.rows) {
      calls_by_endpoint[row.endpoint] = row.cnt;
    }

    return {
      calls_total,
      calls_last_24h,
      calls_by_endpoint,
      cache_saved_calls,
      estimated_cost_usd: calls_total * COST_PER_CALL_USD,
      cache_saved_cost_usd: cache_saved_calls * COST_PER_CALL_USD,
    };
    
  } catch (error) {
    console.error("[repository] getApiCostStats error:", error);
    // Fallback to minimal stats on error
    return {
      calls_total: 0,
      calls_last_24h: 0,
      calls_by_endpoint: {},
      cache_saved_calls: 0,
      estimated_cost_usd: 0,
      cache_saved_cost_usd: 0,
    };
  }
}

/* REMOVED: getApiCostStats_disabled - replaced with PostgreSQL version above */

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
  // DISABLED: SQLite dependency removed, returning null (free user)
  return null;
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

/* REMOVED: createOrUpdateSubscription - replaced with createOrUpdateSubscriptionPg */

/** Check if user has sufficient entitlement to unlock (credits OR active subscription) */
export async function canUserUnlock(userId: string): Promise<{
  canUnlock: boolean;
  reason: 'credits' | 'subscription' | 'insufficient';
  credits: number;
  plan: 'free' | 'basic';
}> {
  const creditBalance = await getCreditBalance(userId);
  const credits = creditBalance.balance;
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

/* REMOVED: grantMonthlyCredits - replaced with grantMonthlyCreditsPg */

// ─── User unlocks (grouped by account) ────────────────

export interface UnlockedAccountEntry {
  account_id: string;
  username: string | null;
  account_created_at: string | null;
  boundary_end: number;
  unlocked_at: string;
  /** True when last persisted excavation marked timeline exhausted (user_account_excavation_meta). */
  diamond_active: boolean;
}

/* REMOVED: getUserUnlockedAccounts - replaced with getUserUnlockedAccountsPg */

// ─── Dev Panel helpers ─────────────────────────────────

export interface DevUnlockEntry {
  account_id: string;
  boundary_end: number;
  job_id: string;
  unlocked_at: string;
  username: string | null;
  account_created_at: string | null;
  cap: number | null;
  unlocked_count: number;
}

/** List all unlocks for a given user, joined with account + job metadata. */
/* REMOVED: getDevUnlocks - replaced with getDevUnlocksPg */

/* REMOVED: deleteDevUnlock - replaced with deleteDevUnlockPg */
/* REMOVED: deleteAllDevUnlocks - replaced with deleteAllDevUnlocksPg */

/* REMOVED: cleanupExpiredHolds - replaced with cleanupExpiredHoldsPg */

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

/* REMOVED: createTemporaryUnlock - replaced with createTemporaryUnlockPg */

/* REMOVED: getTemporaryUnlock - replaced with getTemporaryUnlockPg */

/* REMOVED: transferTemporaryUnlock - replaced with transferTemporaryUnlockPg */

/* REMOVED: cleanupExpiredTemporaryUnlocks - replaced with cleanupExpiredTemporaryUnlocksPg */

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
      "SELECT boundary_end FROM unlocks WHERE user_id = $1 AND account_id = $2",
      [userId, accountId]
    );
    const hasRows = result.rows.length > 0;
    const boundary = hasRows ? result.rows[0].boundary_end : null;
    const isUnlocked = hasRows && (boundary || 0) > 0;
    
    console.log(`[hasUserUnlockedAccountPg] userId=${userId}, accountId=${accountId}, hasRows=${hasRows}, boundary=${boundary}, isUnlocked=${isUnlocked}`);
    
    return isUnlocked;
  } catch (error) {
    console.error("[repository] hasUserUnlockedAccountPg error:", error);
    throw error;
  }
}

/**
 * Create a temporary unlock result for guest users (Postgres version).
 */
export async function createTemporaryUnlockPg(accountId: string, username: string, tweets: any[], jobId?: string | null): Promise<string> {
  try {
    const token = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48 hours TTL
    
    await pgQuery(
      "INSERT INTO temporary_unlocks (token, account_id, username, tweets_json, job_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        token,
        accountId,
        username.toLowerCase(),
        JSON.stringify(tweets),
        jobId || null,
        now.toISOString(),
        expiresAt.toISOString()
      ]
    );
    
    console.log(`[temporary-unlock] Created token ${token} for @${username}${jobId ? ` (job: ${jobId})` : ''} (expires: ${expiresAt.toISOString()})`);
    return token;
  } catch (error) {
    console.error("[repository] createTemporaryUnlockPg error:", error);
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
    
    // Create official unlock record using unified write path
    // Compute boundary from actual cached data instead of hardcoding 100
    const cachedCount = await getCachedTweetCountPg(tempUnlock.account_id);
    const boundary = Math.min(100, cachedCount); // Stage 1 default target
    const { upsertUnlockBoundary } = await import("./unlockWrite");
    await upsertUnlockBoundary(userId, tempUnlock.account_id, boundary, `temp-transfer-${token}`);
    
    console.log(`[temporary-unlock] Transferred token ${token} to user ${userId} for account ${tempUnlock.account_id}`);
    return true;
  } catch (error) {
    console.error("[repository] transferTemporaryUnlockPg error:", error);
    throw error;
  }
}

/**
 * Create checkout session mapping (Postgres version).
 */
export async function createCheckoutSessionPg(sessionId: string, unlockToken: string, username: string): Promise<void> {
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48 hours later
    
    await pgQuery(
      "INSERT INTO checkout_sessions (session_id, unlock_token, username, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [sessionId, unlockToken, username, now.toISOString(), expiresAt.toISOString()]
    );
  } catch (error) {
    console.error("[repository] createCheckoutSessionPg error:", error);
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

/**
 * Release held credits (Postgres version).
 */
export async function releaseHeldPg(holdId: string, reason: string = 'Job failed'): Promise<boolean> {
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
    
    // Mark as released
    await pgQuery(
      "UPDATE credit_holds SET status = 'released' WHERE id = $1",
      [holdId]
    );
    
    // Log event
    const balance = await getCreditBalancePg(hold.user_id);
    await pgQuery(
      "INSERT INTO credit_events (user_id, job_id, hold_id, event_type, amount, balance_after, reason, created_at) VALUES ($1, $2, $3, 'released', $4, $5, $6, NOW())",
      [hold.user_id, hold.job_id, holdId, hold.amount, balance.balance, reason]
    );
    
    return true;
  } catch (error) {
    console.error("[repository] releaseHeldPg error:", error);
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
 * Get tweets by account up to a specific boundary (Postgres version).
 */
export async function getTweetsByAccountUpToBoundaryPg(accountId: string, boundaryEnd: number): Promise<Tweet[]> {
  try {
    const result = await pgQuery(
      "SELECT * FROM tweets WHERE account_id = $1 ORDER BY created_at ASC LIMIT $2",
      [accountId, boundaryEnd]
    );
    return result.rows;
  } catch (error) {
    console.error("[repository] getTweetsByAccountUpToBoundaryPg error:", error);
    throw error;
  }
}

/**
 * Get tweets by account up to guest boundary (Postgres version).
 */
export async function getTweetsByAccountForGuestPg(accountId: string, guestBoundary: number): Promise<Tweet[]> {
  return getTweetsByAccountUpToBoundaryPg(accountId, guestBoundary);
}

/**
 * Get tweets by account with range-based pagination (Postgres version).
 */
export async function getTweetsByAccountRangePg(accountId: string, offset: number, limit: number): Promise<Tweet[]> {
  try {
    const result = await pgQuery(
      "SELECT * FROM tweets WHERE account_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3",
      [accountId, limit, offset]
    );
    return result.rows;
  } catch (error) {
    console.error("[repository] getTweetsByAccountRangePg error:", error);
    throw error;
  }
}

/**
 * Check if user has unlocked up to at least a given boundary (Postgres version).
 * Replaces stage-based check: stage N ≈ boundary >= N*100.
 */
export async function hasUserUnlockedStagePg(userId: string, accountId: string, stage: number): Promise<boolean> {
  const boundary = await getUserBoundaryEndPg(userId, accountId);
  return boundary >= stage * 100;
}

/** @deprecated Use upsertUnlockBoundary from unlockWrite.ts instead */
export async function recordStageUnlockPg(): Promise<void> {
  throw new Error("recordStageUnlockPg is removed — use upsertUnlockBoundary");
}

/**
 * Get user unlocked accounts (Postgres version).
 * One card per account: latest state across all unlock stages.
 */
export async function getUserUnlockedAccountsPg(userId: string): Promise<UnlockedAccountEntry[]> {
  try {
    const result = await pgQuery(
      `SELECT
         u.account_id,
         a.username,
         a.created_at               AS account_created_at,
         u.boundary_end,
         u.unlocked_at,
         COALESCE(m.diamond_active, false) AS diamond_active
       FROM unlocks u
       LEFT JOIN accounts a ON a.account_id = u.account_id
       LEFT JOIN user_account_excavation_meta m
         ON m.user_id = u.user_id AND m.account_id = u.account_id
       WHERE u.user_id = $1
       ORDER BY u.unlocked_at DESC`,
      [userId]
    );
    return result.rows.map((row: UnlockedAccountEntry) => ({
      ...row,
      diamond_active: Boolean(row.diamond_active),
    }));
  } catch (error) {
    console.error("[repository] getUserUnlockedAccountsPg error:", error);
    throw error;
  }
}

/** @deprecated Use upsertUnlockBoundary from unlockWrite.ts instead */
export async function recordUnlockPg(): Promise<void> {
  throw new Error("recordUnlockPg is removed — use upsertUnlockBoundary");
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

/**
 * Get user's current subscription (Postgres version).
 */
export async function getUserSubscriptionPg(userId: string): Promise<Subscription | null> {
  try {
    const result = await pgQuery(
      "SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [userId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0] as Subscription;
  } catch (error) {
    console.error("[repository] getUserSubscriptionPg error:", error);
    return null; // Fail gracefully - treat as free user
  }
}

/**
 * Get effective user plan (Postgres version).
 */
export async function getUserPlanPg(userId: string): Promise<'free' | 'basic'> {
  const subscription = await getUserSubscriptionPg(userId);
  
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

/**
 * Update temporary unlock with actual excavation results (Postgres version).
 */
export async function updateTemporaryUnlockPg(jobId: string, accountId: string, tweets: any[]): Promise<boolean> {
  try {
    const result = await pgQuery(
      "UPDATE temporary_unlocks SET tweets_json = $1 WHERE job_id = $2 AND account_id = $3 RETURNING token",
      [JSON.stringify(tweets), jobId, accountId]
    );
    
    if (result.rowCount && result.rowCount > 0) {
      const token = result.rows[0].token;
      console.log(`[temporary-unlock] Updated token ${token} with ${tweets.length} tweets (job: ${jobId})`);
      return true;
    } else {
      console.log(`[temporary-unlock] No temporary unlock found for job ${jobId}, account ${accountId}`);
      return false;
    }
  } catch (error) {
    console.error("[repository] updateTemporaryUnlockPg error:", error);
    return false;
  }
}

/**
 * Clean up expired temporary unlocks (Postgres version).
 */
export async function cleanupExpiredTemporaryUnlocksPg(): Promise<number> {
  try {
    const result = await pgQuery(
      "DELETE FROM temporary_unlocks WHERE expires_at <= NOW() RETURNING *"
    );
    
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[temporary-unlock] Cleaned up ${result.rowCount} expired temporary unlocks`);
    }
    
    return result.rowCount || 0;
  } catch (error) {
    console.error("[repository] cleanupExpiredTemporaryUnlocksPg error:", error);
    // Non-fatal for cleanup function
    return 0;
  }
}

/**
 * Grant monthly credits to active Basic subscribers (Postgres version).
 */
export async function grantMonthlyCreditsPg(): Promise<{ processed: number; granted: number }> {
  try {
    const now = new Date();
    
    // Find active subscriptions that need credit refresh
    const result = await pgQuery(`
      SELECT * FROM subscriptions 
      WHERE status = 'active' 
        AND cycle_end <= $1
        AND plan = 'basic'
    `, [now.toISOString()]);
    
    const subscriptions = result.rows as Subscription[];
    let processed = 0;
    let granted = 0;
    
    for (const subscription of subscriptions) {
      processed++;
      
      try {
        // Start transaction for each subscription
        await pgQuery("BEGIN");
        
        // Extend cycle
        const newCycleStart = now.toISOString();
        const newCycleEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        
        await pgQuery(`
          UPDATE subscriptions 
          SET cycle_start = $1, cycle_end = $2
          WHERE id = $3
        `, [newCycleStart, newCycleEnd, subscription.id]);
        
        // Grant monthly credits (using Phase 3A unified function)
        await giveCreditsPg(subscription.user_id, subscription.credits_per_cycle, 
                           `Monthly ${subscription.plan} subscription grant`);
        
        granted += subscription.credits_per_cycle;
        
        await pgQuery("COMMIT");
        
        console.log(`[subscription] Granted ${subscription.credits_per_cycle} credits to user ${subscription.user_id}`);
      } catch (error) {
        await pgQuery("ROLLBACK");
        console.error(`[subscription] Failed to grant credits to ${subscription.user_id}:`, error);
      }
    }
    
    console.log(`[subscription] Monthly credit grant: processed=${processed}, granted=${granted}`);
    return { processed, granted };
    
  } catch (error) {
    console.error("[repository] grantMonthlyCreditsPg error:", error);
    return { processed: 0, granted: 0 };
  }
}

/**
 * Create or update a subscription for a user (Postgres version).
 */
export async function createOrUpdateSubscriptionPg(
  userId: string, 
  plan: 'basic' = 'basic',
  creditsPerCycle: number = 4
): Promise<Subscription> {
  try {
    const now = new Date();
    const cycleStart = now.toISOString();
    const cycleEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
    const subscriptionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    
    // Start transaction
    await pgQuery("BEGIN");
    
    try {
      // Cancel any existing active subscriptions
      await pgQuery(`
        UPDATE subscriptions SET status = 'canceled' 
        WHERE user_id = $1 AND status = 'active'
      `, [userId]);
      
      // Create new subscription
      await pgQuery(`
        INSERT INTO subscriptions (id, user_id, plan, cycle_start, cycle_end, credits_per_cycle, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
      `, [subscriptionId, userId, plan, cycleStart, cycleEnd, creditsPerCycle, now.toISOString()]);
      
      // Grant initial cycle credits (using Phase 3A unified function)
      await giveCreditsPg(userId, creditsPerCycle, `${plan} subscription activated`);
      
      await pgQuery("COMMIT");
      
      const subscription: Subscription = {
        id: subscriptionId,
        user_id: userId,
        plan,
        cycle_start: cycleStart,
        cycle_end: cycleEnd,
        credits_per_cycle: creditsPerCycle,
        status: 'active',
        created_at: now.toISOString(),
      };
      
      console.log(`[subscription] Created ${plan} subscription for user ${userId} with ${creditsPerCycle} credits`);
      return subscription;
      
    } catch (error) {
      await pgQuery("ROLLBACK");
      throw error;
    }
    
  } catch (error) {
    console.error("[repository] createOrUpdateSubscriptionPg error:", error);
    throw error;
  }
}

/**
 * Get dev unlocks (Postgres version).
 */
export async function getDevUnlocksPg(userId: string): Promise<DevUnlockEntry[]> {
  try {
    const result = await pgQuery(`
      SELECT
         u.account_id,
         u.boundary_end,
         u.job_id,
         u.unlocked_at,
         a.username,
         a.created_at          AS account_created_at,
         j.requested_limit     AS cap,
         u.boundary_end        AS unlocked_count
       FROM unlocks u
       LEFT JOIN accounts a ON a.account_id = u.account_id
       LEFT JOIN jobs     j ON j.id          = u.job_id
       WHERE u.user_id = $1
       ORDER BY u.unlocked_at DESC
    `, [userId]);
    
    return result.rows as DevUnlockEntry[];
  } catch (error) {
    console.error("[repository] getDevUnlocksPg error:", error);
    throw error;
  }
}

/**
 * Delete one unlock record for a user+account pair (Postgres version).
 */
export async function deleteDevUnlockPg(userId: string, accountId: string): Promise<number> {
  try {
    const result = await pgQuery(
      "DELETE FROM unlocks WHERE user_id = $1 AND account_id = $2",
      [userId, accountId]
    );
    return result.rowCount || 0;
  } catch (error) {
    console.error("[repository] deleteDevUnlockPg error:", error);
    throw error;
  }
}

/**
 * Delete ALL unlock records for a user (Postgres version).
 */
export async function deleteAllDevUnlocksPg(userId: string): Promise<number> {
  try {
    const result = await pgQuery(
      "DELETE FROM unlocks WHERE user_id = $1",
      [userId]
    );
    return result.rowCount || 0;
  } catch (error) {
    console.error("[repository] deleteAllDevUnlocksPg error:", error);
    throw error;
  }
}

// ========================================
// STAGE RESULTS (Postgres versions)
// ========================================

export interface StageResult {
  id: number;
  account_id: string;
  stage: number;
  target_count: number;
  collected_count: number;
  status: string;
  job_id: string;
  created_at: string;
}

/**
 * Check if a stage result already exists for an account (Postgres version).
 */
export async function getStageResultPg(accountId: string, stage: number): Promise<StageResult | null> {
  try {
    const result = await pgQuery(
      "SELECT * FROM stage_results WHERE account_id = $1 AND stage = $2",
      [accountId, stage]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      id: row.id,
      account_id: row.account_id,
      stage: row.stage,
      target_count: row.target_count,
      collected_count: row.collected_count,
      status: row.status,
      job_id: row.job_id,
      created_at: row.created_at,
    };
  } catch (error) {
    console.error("[repository] getStageResultPg error:", error);
    throw error;
  }
}

/**
 * Store a stage result after excavation completes (Postgres version).
 */
export async function storeStageResultPg(
  accountId: string,
  stage: number,
  excavationResult: {
    requestedLimit: number;
    fetchedCount: number;
    stopReason: string;
  },
  jobId: string
): Promise<void> {
  try {
    const result = await pgQuery(
      `INSERT INTO stage_results 
       (account_id, stage, target_count, collected_count, status, job_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (account_id, stage) DO NOTHING`,
      [
        accountId,
        stage,
        excavationResult.requestedLimit,
        excavationResult.fetchedCount,
        excavationResult.stopReason,
        jobId
      ]
    );
    
    if (result.rowCount === 0) {
      console.log(
        `[stage] Stage ${stage} result for account ${accountId} already exists - respecting immutability`
      );
    } else {
      console.log(
        `[stage] Stored Stage ${stage} result: account=${accountId} collected=${excavationResult.fetchedCount} target=${excavationResult.requestedLimit}`
      );
    }
  } catch (error) {
    console.error("[repository] storeStageResultPg error:", error);
    throw error;
  }
}

/**
 * Check if all prerequisite stages exist (Postgres version).
 */
export async function checkStagePrerequisitesPg(accountId: string, targetStage: number): Promise<number | null> {
  try {
    if (targetStage <= 1) return null;
    
    for (let stage = 1; stage < targetStage; stage++) {
      const result = await pgQuery(
        "SELECT 1 FROM stage_results WHERE account_id = $1 AND stage = $2",
        [accountId, stage]
      );
      
      if (result.rows.length === 0) {
        return stage; // Return missing prerequisite stage number
      }
    }
    
    return null; // All prerequisites satisfied
  } catch (error) {
    console.error("[repository] checkStagePrerequisitesPg error:", error);
    throw error;
  }
}

/**
 * Get the highest completed stage for an account (Postgres version).
 */
export async function getAccountHighestStagePg(accountId: string): Promise<number> {
  try {
    const result = await pgQuery(
      "SELECT MAX(stage) as max_stage FROM stage_results WHERE account_id = $1",
      [accountId]
    );
    return result.rows[0]?.max_stage ?? 0;
  } catch (error) {
    console.error("[repository] getAccountHighestStagePg error:", error);
    throw error;
  }
}

/**
 * Get all stage results for an account (Postgres version).
 */
export async function getAccountStageResultsPg(accountId: string): Promise<StageResult[]> {
  try {
    const result = await pgQuery(
      "SELECT * FROM stage_results WHERE account_id = $1 ORDER BY stage ASC",
      [accountId]
    );
    
    return result.rows.map(row => ({
      id: row.id,
      account_id: row.account_id,
      stage: row.stage,
      target_count: row.target_count,
      collected_count: row.collected_count,
      status: row.status,
      job_id: row.job_id,
      created_at: row.created_at,
    }));
  } catch (error) {
    console.error("[repository] getAccountStageResultsPg error:", error);
    throw error;
  }
}

// ========================================
// UNLOCK PLANNING (Postgres versions)
// ========================================

/**
 * Get newest cached tweet timestamp for continuation (Postgres version).
 */
export async function getNewestCachedTweetTimestampPg(accountId: string): Promise<string | null> {
  try {
    const result = await pgQuery(
      "SELECT created_at FROM tweets WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1",
      [accountId]
    );
    return result.rows.length > 0 ? result.rows[0].created_at : null;
  } catch (error) {
    console.error("[repository] getNewestCachedTweetTimestampPg error:", error);
    throw error;
  }
}

/**
 * Extract newly unlocked posts for result range (Postgres version).
 */
export async function extractNewlyUnlockedPostsPg(accountId: string, offset: number, limit: number): Promise<any[]> {
  try {
    const result = await pgQuery(
      `SELECT 
         post_id,
         account_id,
         created_at,
         full_text,
         media_json,
         like_count,
         retweet_count,
         reply_count,
         fetched_at
       FROM tweets 
       WHERE account_id = $1
       ORDER BY created_at ASC
       LIMIT $2 OFFSET $3`,
      [accountId, limit, offset]
    );
    
    return result.rows;
  } catch (error) {
    console.error("[repository] extractNewlyUnlockedPostsPg error:", error);
    throw error;
  }
}

// ========================================
// JOB MANAGEMENT (Postgres versions)
// ========================================

export interface JobRecord {
  id: string;
  account_username: string;
  account_id: string | null;
  user_id: string;
  requested_limit: number;
  stage: number;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  error_code: string | null;
  error_message: string | null;
  result_json: string | null;
  api_calls: number;
  fetched_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  hold_id: string | null;
  resume_at: string | null;
  resume_state: string | null;
}

/**
 * Create a new job record (Postgres version).
 */
export async function createJobPg(jobData: {
  id: string;
  account_username: string;
  account_id?: string | null;
  user_id: string;
  requested_limit: number;
  stage: number;
  hold_id?: string | null;
}): Promise<void> {
  try {
    await pgQuery(
      `INSERT INTO jobs (id, account_username, account_id, user_id, requested_limit, stage, hold_id, status, api_calls, fetched_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 0, 0, NOW())`,
      [
        jobData.id,
        jobData.account_username,
        jobData.account_id || null,
        jobData.user_id,
        jobData.requested_limit,
        jobData.stage,
        jobData.hold_id || null
      ]
    );
  } catch (error) {
    console.error("[repository] createJobPg error:", error);
    throw error;
  }
}

/**
 * Get job by ID (Postgres version).
 */
export async function getJobPg(jobId: string): Promise<JobRecord | null> {
  try {
    const result = await pgQuery(
      "SELECT * FROM jobs WHERE id = $1",
      [jobId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      id: row.id,
      account_username: row.account_username,
      account_id: row.account_id,
      user_id: row.user_id,
      requested_limit: row.requested_limit,
      stage: row.stage,
      status: row.status,
      error_code: row.error_code,
      error_message: row.error_message,
      result_json: row.result_json,
      api_calls: row.api_calls,
      fetched_count: row.fetched_count,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      hold_id: row.hold_id,
      resume_at: row.resume_at,
      resume_state: row.resume_state,
    };
  } catch (error) {
    console.error("[repository] getJobPg error:", error);
    throw error;
  }
}

/**
 * Update job status (Postgres version).
 */
export async function updateJobStatusPg(jobId: string, status?: string, additionalData: {
  started_at?: string;
  finished_at?: string;
  error_code?: string;
  error_message?: string;
  result_json?: string;
  api_calls?: number;
  fetched_count?: number;
  resume_at?: string | null;
  resume_state?: string | null;
} = {}): Promise<void> {
  try {
    const fields: string[] = [];
    const values: any[] = [jobId];
    let paramIndex = 2;
    
    // Add status field if provided
    if (status !== undefined) {
      fields.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }
    
    // Add optional fields
    if (additionalData.started_at !== undefined) {
      fields.push(`started_at = $${paramIndex}`);
      values.push(additionalData.started_at);
      paramIndex++;
    }
    if (additionalData.finished_at !== undefined) {
      fields.push(`finished_at = $${paramIndex}`);
      values.push(additionalData.finished_at);
      paramIndex++;
    }
    if (additionalData.error_code !== undefined) {
      fields.push(`error_code = $${paramIndex}`);
      values.push(additionalData.error_code);
      paramIndex++;
    }
    if (additionalData.error_message !== undefined) {
      fields.push(`error_message = $${paramIndex}`);
      values.push(additionalData.error_message);
      paramIndex++;
    }
    if (additionalData.result_json !== undefined) {
      fields.push(`result_json = $${paramIndex}`);
      values.push(additionalData.result_json);
      paramIndex++;
    }
    if (additionalData.api_calls !== undefined) {
      fields.push(`api_calls = $${paramIndex}`);
      values.push(additionalData.api_calls);
      paramIndex++;
    }
    if (additionalData.fetched_count !== undefined) {
      fields.push(`fetched_count = $${paramIndex}`);
      values.push(additionalData.fetched_count);
      paramIndex++;
    }
    if (additionalData.resume_at !== undefined) {
      fields.push(`resume_at = $${paramIndex}`);
      values.push(additionalData.resume_at);
      paramIndex++;
    }
    if (additionalData.resume_state !== undefined) {
      fields.push(`resume_state = $${paramIndex}`);
      values.push(additionalData.resume_state);
      paramIndex++;
    }
    
    // Only run update if there are fields to update
    if (fields.length === 0) {
      return; // Nothing to update
    }
    
    const query = `UPDATE jobs SET ${fields.join(', ')} WHERE id = $1`;
    await pgQuery(query, values);
  } catch (error) {
    console.error("[repository] updateJobStatusPg error:", error);
    throw error;
  }
}

/**
 * Update job to running state (Postgres version).
 */
export async function updateJobToRunningPg(jobId: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    await pgQuery(
      "UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, $1), resume_at = NULL WHERE id = $2",
      [now, jobId]
    );
  } catch (error) {
    console.error("[repository] updateJobToRunningPg error:", error);
    throw error;
  }
}

/**
 * Cancel job by ID (Postgres version).
 */
export async function cancelJobPg(jobId: string): Promise<boolean> {
  try {
    // Get current job info
    const job = await getJobPg(jobId);
    if (!job || job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
      return false; // Job not found or already terminal
    }
    
    // Update to canceled
    await updateJobStatusPg(jobId, 'canceled');
    
    // Release hold if exists
    if (job.hold_id) {
      // Note: releaseHeldPg would need to be implemented if not already done
      console.log(`[jobs] Job ${jobId} canceled, hold ${job.hold_id} should be released`);
    }
    
    return true;
  } catch (error) {
    console.error("[repository] cancelJobPg error:", error);
    throw error;
  }
}

/**
 * Get jobs for initialization (failed detection) (Postgres version).
 */
export async function getJobsForInitPg(): Promise<{ runningJobs: JobRecord[]; queuedJobs: JobRecord[] }> {
  try {
    const runningResult = await pgQuery(
      "SELECT * FROM jobs WHERE status = 'running'"
    );
    
    const queuedResult = await pgQuery(
      "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC"
    );
    
    const mapJobRecord = (row: any): JobRecord => ({
      id: row.id,
      account_username: row.account_username,
      account_id: row.account_id,
      user_id: row.user_id,
      requested_limit: row.requested_limit,
      stage: row.stage,
      status: row.status,
      error_code: row.error_code,
      error_message: row.error_message,
      result_json: row.result_json,
      api_calls: row.api_calls,
      fetched_count: row.fetched_count,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      hold_id: row.hold_id,
      resume_at: row.resume_at,
      resume_state: row.resume_state,
    });
    
    return {
      runningJobs: runningResult.rows.map(mapJobRecord),
      queuedJobs: queuedResult.rows.map(mapJobRecord),
    };
  } catch (error) {
    console.error("[repository] getJobsForInitPg error:", error);
    throw error;
  }
}

/**
 * Get credit hold by job ID (Postgres version).
 */
export async function getHoldByJobIdPg(jobId: string): Promise<{ id: string; user_id: string; amount: number; status: string } | null> {
  try {
    const result = await pgQuery(
      "SELECT id, user_id, amount, status FROM credit_holds WHERE job_id = $1 AND status = 'held'",
      [jobId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      id: row.id,
      user_id: row.user_id,
      amount: row.amount,
      status: row.status
    };
  } catch (error) {
    console.error("[repository] getHoldByJobIdPg error:", error);
    throw error;
  }
}

/**
 * Get user boundary end for an account (Postgres version).
 */
export async function getUserBoundaryEndPg(userId: string, accountId: string): Promise<number> {
  try {
    const result = await pgQuery(
      "SELECT boundary_end FROM unlocks WHERE user_id = $1 AND account_id = $2",
      [userId, accountId]
    );
    
    if (result.rows.length === 0) return 0;
    return result.rows[0].boundary_end ?? 0;
  } catch (error) {
    console.error("[repository] getUserBoundaryEndPg error:", error);
    throw error;
  }
}

/** Error code returned by POST /api/unlock/extend when cooldown is active. */
export const EXTEND_COOLDOWN_AFTER_EXHAUST_CODE = "EXTEND_COOLDOWN_AFTER_EXHAUST" as const;

const EXTEND_COOLDOWN_HOURS = 24;

/**
 * When extend is blocked until this instant (user + account), or null if no row / expired.
 */
export async function getExtendBlockedUntilPg(
  userId: string,
  accountId: string,
): Promise<Date | null> {
  try {
    const result = await pgQuery(
      `SELECT extend_blocked_until FROM user_account_excavation_meta
       WHERE user_id = $1 AND account_id = $2`,
      [userId, accountId],
    );
    if (result.rows.length === 0) return null;
    const raw = result.rows[0].extend_blocked_until;
    if (raw == null) return null;
    const d = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  } catch (error) {
    console.error("[repository] getExtendBlockedUntilPg error:", error);
    throw error;
  }
}

/**
 * After a timeline-exhausted successful job, block additional excavation (extend) for this user+account.
 */
export async function setExtendCooldownAfterTimelineExhaustPg(
  userId: string,
  accountId: string,
  hours: number = EXTEND_COOLDOWN_HOURS,
): Promise<void> {
  try {
    await pgQuery(
      `INSERT INTO user_account_excavation_meta (user_id, account_id, extend_blocked_until, updated_at)
       VALUES ($1, $2, NOW() + ($3::integer * INTERVAL '1 hour'), NOW())
       ON CONFLICT (user_id, account_id) DO UPDATE SET
         extend_blocked_until = NOW() + ($3::integer * INTERVAL '1 hour'),
         updated_at = NOW()`,
      [userId, accountId, hours],
    );
  } catch (error) {
    console.error("[repository] setExtendCooldownAfterTimelineExhaustPg error:", error);
    throw error;
  }
}

/** Epoch placeholder for extend_blocked_until when creating a meta row for diamond-only upsert (cooldown inactive). */
const EXTEND_BLOCKED_PLACEHOLDER = "1970-01-01T00:00:00.000Z";

/**
 * Option A: overwrite 💎 snapshot on each successful job that ran the excavation engine.
 * Does not touch extend_blocked_until on conflict (preserves active cooldown).
 */
export async function upsertDiamondSnapshotPg(
  userId: string,
  accountId: string,
  diamondActive: boolean,
): Promise<void> {
  try {
    await pgQuery(
      `INSERT INTO user_account_excavation_meta (user_id, account_id, extend_blocked_until, updated_at, diamond_active)
       VALUES ($1, $2, $3::timestamptz, NOW(), $4)
       ON CONFLICT (user_id, account_id) DO UPDATE SET
         diamond_active = EXCLUDED.diamond_active,
         updated_at = NOW()`,
      [userId, accountId, EXTEND_BLOCKED_PLACEHOLDER, diamondActive],
    );
  } catch (error) {
    console.error("[repository] upsertDiamondSnapshotPg error:", error);
    throw error;
  }
}

export async function getDiamondActivePg(
  userId: string,
  accountId: string,
): Promise<boolean> {
  try {
    const result = await pgQuery(
      `SELECT diamond_active FROM user_account_excavation_meta
       WHERE user_id = $1 AND account_id = $2`,
      [userId, accountId],
    );
    if (result.rows.length === 0) return false;
    return Boolean(result.rows[0].diamond_active);
  } catch (error) {
    console.error("[repository] getDiamondActivePg error:", error);
    throw error;
  }
}
