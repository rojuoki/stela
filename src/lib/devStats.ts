/**
 * Dev-only in-memory request telemetry + X API counters.
 * All functions are no-ops when NEXT_PUBLIC_DEV_PANEL !== "1".
 * Never persisted — resets on process restart.
 */

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

const MAX_ENTRIES = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

export type DevStatScope =
  | "credits"
  | "lookup"
  | "unlock"
  | "excavate"
  | "jobs"
  | "other";

export type DevStatEntry = {
  ts: number;
  scope: DevStatScope;
  route: string;
  userId?: string;
  username?: string;
  status: number;
  ms: number;
  note?: string;
};

type ScopeAgg = {
  count: number;
  ok: number;
  err: number;
  p50ms: number;
  p95ms: number;
  maxms: number;
  lastStatus?: number;
  lastTs?: number;
};

export type StatsSummary = {
  entries: DevStatEntry[];
  byScope: Record<string, ScopeAgg>;
  totals: { count: number; ok: number; err: number };
  xapi: { calls: number; http429: number; last429Ts?: number };
};

// ── In-memory store ───────────────────────────────────────────────────────────

let _entries: DevStatEntry[] = [];
let _xCalls = 0;
let _x429 = 0;
let _last429Ts: number | undefined;

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, idx)];
}

// ── Public API ────────────────────────────────────────────────────────────────

export function record(entry: DevStatEntry): void {
  if (!DEV_PANEL) return;
  _entries.unshift(entry); // latest first
  if (_entries.length > MAX_ENTRIES) _entries.length = MAX_ENTRIES;
}

export function incXApiCalls(n = 1): void {
  if (!DEV_PANEL) return;
  _xCalls += n;
}

export function incXApi429(): void {
  if (!DEV_PANEL) return;
  _x429++;
  _last429Ts = Date.now();
}

export function reset(): void {
  _entries = [];
  _xCalls = 0;
  _x429 = 0;
  _last429Ts = undefined;
}

export function getSummary(): StatsSummary {
  // Aggregate per scope
  const scopeMap = new Map<
    string,
    { lat: number[]; ok: number; err: number; lastStatus?: number; lastTs?: number }
  >();

  for (const e of _entries) {
    if (!scopeMap.has(e.scope)) {
      scopeMap.set(e.scope, { lat: [], ok: 0, err: 0 });
    }
    const s = scopeMap.get(e.scope)!;
    s.lat.push(e.ms);
    if (e.status >= 400) s.err++;
    else s.ok++;
    // entries are latest-first so first seen = most recent
    if (s.lastStatus === undefined) {
      s.lastStatus = e.status;
      s.lastTs = e.ts;
    }
  }

  const byScope: Record<string, ScopeAgg> = {};
  for (const [scope, s] of scopeMap.entries()) {
    const sorted = [...s.lat].sort((a, b) => a - b);
    byScope[scope] = {
      count: s.lat.length,
      ok: s.ok,
      err: s.err,
      p50ms: pct(sorted, 50),
      p95ms: pct(sorted, 95),
      maxms: sorted[sorted.length - 1] ?? 0,
      lastStatus: s.lastStatus,
      lastTs: s.lastTs,
    };
  }

  const ok = _entries.filter((e) => e.status < 400).length;
  const err = _entries.length - ok;

  return {
    entries: _entries.slice(0, 20), // most recent 20 for the log
    byScope,
    totals: { count: _entries.length, ok, err },
    xapi: { calls: _xCalls, http429: _x429, last429Ts: _last429Ts },
  };
}
