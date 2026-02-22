import { getDevUserId } from "@/dev/state";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

/**
 * Drop-in replacement for fetch() that attaches x-stela-user in dev mode.
 * Use this for all UI calls to API routes that are user-scoped.
 */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!DEV_PANEL) return fetch(input, init);

  const headers = new Headers(init.headers);
  headers.set("x-stela-user", getDevUserId());
  return fetch(input, { ...init, headers });
}
