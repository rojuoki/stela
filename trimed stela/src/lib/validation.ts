/**
 * STELA Input validation and normalization — Phase 7
 */

/** Normalize username: accept "@username" or "username", return clean lowercase */
export function normalizeUsername(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  
  const clean = input.trim().replace(/^@/, "").toLowerCase();
  
  // X username rules: 1-15 chars, alphanumeric + underscore only
  if (!/^[a-z0-9_]{1,15}$/.test(clean)) {
    return null;
  }
  
  return clean;
}

/** Validate and clamp limit to safe range */
export function validateLimit(input: unknown): number {
  if (typeof input === "string") {
    const parsed = parseInt(input, 10);
    if (isNaN(parsed)) return 100;
    return Math.min(Math.max(parsed, 1), 100);
  }
  
  if (typeof input === "number") {
    return Math.min(Math.max(Math.floor(input), 1), 100);
  }
  
  return 100; // default
}

/** Basic rate limiting: simple in-memory store */
interface RateLimit {
  requests: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimit>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute per IP

export function checkRateLimit(identifier: string): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const key = `rate:${identifier}`;
  
  let limit = rateLimitStore.get(key);
  
  if (!limit || now > limit.resetTime) {
    // Reset window
    limit = {
      requests: 0,
      resetTime: now + RATE_LIMIT_WINDOW,
    };
  }
  
  if (limit.requests >= RATE_LIMIT_MAX) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: limit.resetTime,
    };
  }
  
  limit.requests++;
  rateLimitStore.set(key, limit);
  
  // Cleanup old entries periodically
  if (Math.random() < 0.01) { // 1% chance
    for (const [k, v] of rateLimitStore.entries()) {
      if (now > v.resetTime) {
        rateLimitStore.delete(k);
      }
    }
  }
  
  return {
    allowed: true,
    remaining: RATE_LIMIT_MAX - limit.requests,
    resetTime: limit.resetTime,
  };
}