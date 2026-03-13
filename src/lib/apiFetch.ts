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
 * Drop-in replacement for fetch() that attaches dev headers in dev mode and 
 * ensures auth cookies are included:
 *   x-stela-user          – active dev user (dev mode only)
 *   x-stela-dev-error     – forced error mode (dev mode only)
 *   x-stela-dev-delay-ms  – delay in ms (dev mode only)
 *   
 * Always includes credentials for authentication cookies.
 * When "Next request only" is ON and mode != none, clears the mode after
 * the first request so subsequent calls behave normally.
 */
export async function apiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  
  // Always include credentials for auth cookies
  const requestInit: RequestInit = {
    ...init,
    headers,
    credentials: 'include', // Include auth cookies
  };

  // In dev mode, add dev headers
  if (DEV_PANEL) {
    headers.set("x-stela-user", getDevUserId());

    const mode = getDevErrorMode();
    const once = getDevErrorOnce();

    if (mode !== "none") {
      headers.set("x-stela-dev-error", mode);
      if (mode === "delay") {
        headers.set("x-stela-dev-delay-ms", String(getDevDelayMs()));
      }
    }

    const response = await fetch(input, requestInit);

    // Auto-clear after first injected request when "once" is enabled.
    if (mode !== "none" && once) {
      setDevErrorMode("none");
      dispatchDevChanged();
    }

    return response;
  }

  // Production mode - just fetch with auth cookies
  return fetch(input, requestInit);
}
