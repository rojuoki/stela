export const DEV_USERS = [
  "alan",
  "kentaro",
  "MrT",
  "yuki",
  "hana",
  "ryo",
  "guest",
] as const;

export const DEV_PLANS = ["free", "basic", "pro"] as const;
export type DevPlan = (typeof DEV_PLANS)[number];

export const DEV_ERROR_MODES = ["none", "429", "500", "timeout", "delay"] as const;
export type DevErrorMode = (typeof DEV_ERROR_MODES)[number];

const USER_KEY = "stela_dev_user_id";
const PLAN_KEY = "stela_dev_plan";
const ERROR_MODE_KEY = "stela_dev_error_mode";
const DELAY_MS_KEY  = "stela_dev_delay_ms";
const ERROR_ONCE_KEY = "stela_dev_error_once";

export function getDevUserId(): string {
  if (typeof window === "undefined") return "guest";
  return localStorage.getItem(USER_KEY) ?? "guest";
}

export function setDevUserId(userId: string): void {
  localStorage.setItem(USER_KEY, userId);
}

export function getDevPlan(): DevPlan {
  if (typeof window === "undefined") return "basic";
  const v = localStorage.getItem(PLAN_KEY);
  if (v === "free" || v === "basic" || v === "pro") return v;
  return "basic";
}

export function setDevPlan(plan: DevPlan): void {
  localStorage.setItem(PLAN_KEY, plan);
}

export function getDevErrorMode(): DevErrorMode {
  if (typeof window === "undefined") return "none";
  const v = localStorage.getItem(ERROR_MODE_KEY);
  if (v === "429" || v === "500" || v === "timeout" || v === "delay") return v;
  return "none";
}

export function setDevErrorMode(mode: DevErrorMode): void {
  localStorage.setItem(ERROR_MODE_KEY, mode);
}

/** delayMs is clamped to [100, 30000]. Defaults to 2000. */
export function getDevDelayMs(): number {
  if (typeof window === "undefined") return 2000;
  const v = parseInt(localStorage.getItem(DELAY_MS_KEY) ?? "2000", 10);
  return isNaN(v) ? 2000 : Math.max(100, Math.min(30_000, v));
}

export function setDevDelayMs(ms: number): void {
  localStorage.setItem(DELAY_MS_KEY, String(ms));
}

/** "Next request only" toggle — defaults to true. */
export function getDevErrorOnce(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(ERROR_ONCE_KEY) !== "0"; // default true
}

export function setDevErrorOnce(once: boolean): void {
  localStorage.setItem(ERROR_ONCE_KEY, once ? "1" : "0");
}

/** Single unified event for all dev-state changes (user + plan + error mode). */
export function dispatchDevChanged(): void {
  window.dispatchEvent(new Event("stelaDevChanged"));
}
