/**
 * cacheDebug.ts — browser-side cache hit/miss ring buffer (dev-only)
 *
 * Never imported in production code paths; callers guard with
 *   if (process.env.NEXT_PUBLIC_DEV_PANEL === "1") { ... }
 *
 * Cross-component sync: fires "stelaDevCacheChanged" on window after
 * every recordCacheEvent() call so DevPanel can re-render cheaply.
 */

export type CacheTier = "user" | "shared" | "none";

export interface CacheEvent {
  type: "lookup" | "unlock";
  hit: boolean;
  tier: CacheTier;
  username?: string;
  /** tweets served from cache (unlock only) */
  cachedCount?: number;
  ts: number;
}

const MAX_EVENTS = 50;
export const DEV_CACHE_CHANGED_EVENT = "stelaDevCacheChanged";

let _events: CacheEvent[] = [];

export function recordCacheEvent(e: Omit<CacheEvent, "ts">): void {
  const event: CacheEvent = { ...e, ts: Date.now() };
  _events = [event, ..._events].slice(0, MAX_EVENTS);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DEV_CACHE_CHANGED_EVENT));
  }
}

export function getLastByType(type: CacheEvent["type"]): CacheEvent | null {
  return _events.find((e) => e.type === type) ?? null;
}

export function getCacheTotals(): {
  hits: number;
  misses: number;
  total: number;
  hitRate: number;
} {
  const hits = _events.filter((e) => e.hit).length;
  const total = _events.length;
  return {
    hits,
    misses: total - hits,
    total,
    hitRate: total === 0 ? 0 : Math.round((hits / total) * 100),
  };
}

export function getCacheEvents(): CacheEvent[] {
  return _events;
}

export function resetCacheDebug(): void {
  _events = [];
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(DEV_CACHE_CHANGED_EVENT));
  }
}
