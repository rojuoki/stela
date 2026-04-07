/**
 * Thin measurement wrapper for API route handlers (dev only).
 *
 * Usage:
 *   const ctx: MeasureCtx = { userId, route: "/api/unlock" };
 *   return withDevMeasure("unlock", async () => { ... }, ctx);
 *
 * ctx is captured by reference — mutate ctx.username inside fn()
 * before the first response and it will appear in the recorded entry.
 */

import { record } from "./devStats";
import type { DevStatScope } from "./devStats";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

export type MeasureCtx = {
  route?: string;
  userId?: string;
  username?: string;
  note?: string;
};

export async function withDevMeasure(
  scope: DevStatScope,
  fn: () => Promise<Response>,
  ctx?: MeasureCtx,
): Promise<Response> {
  if (!DEV_PANEL) return fn();

  const start = Date.now();
  try {
    const res = await fn();
    record({
      ts: start,
      scope,
      route: ctx?.route ?? "",
      userId: ctx?.userId,
      username: ctx?.username,
      status: res.status,
      ms: Date.now() - start,
      note: ctx?.note,
    });
    return res;
  } catch (e) {
    record({
      ts: start,
      scope,
      route: ctx?.route ?? "",
      userId: ctx?.userId,
      username: ctx?.username,
      status: 500,
      ms: Date.now() - start,
      note: "thrown",
    });
    throw e;
  }
}
