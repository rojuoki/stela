import { ioPgQuery } from "./pg-db";

export class IoProfileError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}
export interface IoProfile {
  account_id: string; username: string; display_name: string | null;
  avatar_url: string | null; description: string | null; created_at: string | null;
  protected: boolean; followers_count: number; following_count: number; statuses_count: number;
}
const pending = new Map<string, Promise<IoProfile>>();
const select = `SELECT account_id, username, display_name, avatar_url, description,
  created_at, protected, followers_count::float8, following_count::float8,
  statuses_count::float8 FROM accounts WHERE LOWER(username)=LOWER($1)`;
const string = (value: unknown) => typeof value === "string" ? value : null;
const count = (value: unknown) => Math.max(0, Number(value) || 0);

export async function getOrFetchIoProfile(username: string): Promise<IoProfile> {
  const cached = await ioPgQuery<IoProfile>(select, [username]);
  if (cached.rows[0]?.display_name) return cached.rows[0];
  const key = username.toLowerCase();
  const existing = pending.get(key);
  if (existing) return existing;
  const task = fetchAndSave(username).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
async function fetchAndSave(username: string): Promise<IoProfile> {
  const apiKey = process.env.TWITTERAPI_IO_API_KEY;
  if (!apiKey) throw new IoProfileError("Profile service configuration is missing.", 503);
  let response: Response;
  try {
    response = await fetch(`https://api.twitterapi.io/twitter/user/info?userName=${encodeURIComponent(username)}`, {
      headers: { "X-API-Key": apiKey }, cache: "no-store", signal: AbortSignal.timeout(15000),
    });
  } catch { throw new IoProfileError("Couldn’t load the profile. Please wait a moment and try again."); }
  if (response.status === 404) throw new IoProfileError("Account not found.", 404);
  if (response.status === 429) throw new IoProfileError("Search is busy. Please wait a moment and try again.", 429);
  if (!response.ok) throw new IoProfileError("Couldn’t connect to the profile service.");
  const body = await response.json().catch(() => null);
  const data = body?.data;
  if (!data || !data.id || !data.userName || data.unavailable || body.status === "error") throw new IoProfileError("Couldn’t load this account’s profile.", 404);
  if (String(data.userName).toLowerCase() !== username.toLowerCase()) throw new IoProfileError("The returned profile did not match the requested account.");
  const created = Date.parse(data.createdAt);
  const profile: IoProfile = {
    account_id: String(data.id), username: String(data.userName), display_name: string(data.name) || String(data.userName),
    avatar_url: string(data.profilePicture), description: string(data.description),
    created_at: Number.isFinite(created) ? new Date(created).toISOString() : null,
    protected: data.protected === true, followers_count: count(data.followers), following_count: count(data.following),
    statuses_count: count(data.statusesCount),
  };
  await ioPgQuery(`INSERT INTO accounts (account_id, username, display_name, avatar_url, description, created_at, protected, followers_count, following_count, statuses_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (account_id) DO UPDATE SET username=EXCLUDED.username, display_name=EXCLUDED.display_name,
    avatar_url=EXCLUDED.avatar_url, description=EXCLUDED.description, created_at=COALESCE(EXCLUDED.created_at, accounts.created_at),
    protected=EXCLUDED.protected, followers_count=EXCLUDED.followers_count, following_count=EXCLUDED.following_count,
    statuses_count=EXCLUDED.statuses_count, fetched_at=NOW()`,
    [profile.account_id, profile.username, profile.display_name, profile.avatar_url, profile.description, profile.created_at, profile.protected, profile.followers_count, profile.following_count, profile.statuses_count]);
  return profile;
}
