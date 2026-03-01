export interface MediaData {
  media_key: string;
  type: "photo" | "video" | "animated_gif";
  url?: string;
  preview_image_url?: string;
  width?: number;
  height?: number;
  alt_text?: string;
}

export interface TweetData {
  post_id: string;
  account_id: string;
  created_at: string;
  full_text: string;
  media_json: string | null;
  like_count: number;
  retweet_count: number;
  reply_count: number;
  media?: MediaData[]; // パースされたメディアデータ
}

export interface AccountData {
  account_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | null;
  protected: boolean;
  source: "cache" | "api";
}

export type AccountStatus = "idle" | "loading" | "found" | "error";
export type Status = "idle" | "running" | "done" | "failed";
export type JobPhase = null | "queued" | "running" | "waiting_rate_limit";

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
