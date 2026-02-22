import {
  getDevUserId,
  getDevErrorMode,
  getDevDelayMs,
  getDevErrorOnce,
  setDevErrorMode,
  dispatchDevChanged,
} from "@/dev/state";

const DEV_PANEL = process.env.NEXT_PUBLIC_DEV_PANEL === "1";

/**
 * Drop-in replacement for fetch() that attaches dev headers in dev mode:
 *   x-stela-user          – active dev user
 *   x-stela-dev-error     – forced error mode (none/429/500/timeout/delay)
 *   x-stela-dev-delay-ms  – delay in ms (only when mode=delay)
 *
 * When "Next request only" is ON and mode != none, clears the mode after
 * the first request so subsequent calls behave normally.
 */
export async function apiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!DEV_PANEL) return fetch(input, init);

  const headers = new Headers(init.headers);
  headers.set("x-stela-user", getDevUserId());

  const mode = getDevErrorMode();
  const once = getDevErrorOnce();

  if (mode !== "none") {
    headers.set("x-stela-dev-error", mode);
    if (mode === "delay") {
      headers.set("x-stela-dev-delay-ms", String(getDevDelayMs()));
    }
  }

  const response = await fetch(input, { ...init, headers });

  // Auto-clear after first injected request when "once" is enabled.
  if (mode !== "none" && once) {
    setDevErrorMode("none");
    dispatchDevChanged();
  }

  return response;
}
