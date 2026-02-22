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

const USER_KEY = "stela_dev_user_id";
const PLAN_KEY = "stela_dev_plan";

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

/** Single unified event for all dev-state changes (user + plan). */
export function dispatchDevChanged(): void {
  window.dispatchEvent(new Event("stelaDevChanged"));
}
