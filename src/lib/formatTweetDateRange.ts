import type { TweetData } from "../components/types";

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Formats the span from earliest to latest tweet in `tweets` for chart headings.
 * Uses en dash (–) between endpoints; omits redundant year when both dates share a year.
 */
export function formatTweetDateRangeHeading(tweets: TweetData[]): string {
  if (tweets.length === 0) return "";
  const sorted = [...tweets].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const first = new Date(sorted[0].created_at);
  const last = new Date(sorted[sorted.length - 1].created_at);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) {
    return "";
  }

  const y1 = first.getFullYear();
  const m1 = first.getMonth();
  const d1 = first.getDate();
  const y2 = last.getFullYear();
  const m2 = last.getMonth();
  const d2 = last.getDate();

  const one = (d: Date) =>
    `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

  if (y1 === y2 && m1 === m2 && d1 === d2) {
    return one(first);
  }
  if (y1 === y2) {
    return `${MONTH_SHORT[m1]} ${d1} – ${MONTH_SHORT[m2]} ${d2}, ${y1}`;
  }
  return `${MONTH_SHORT[m1]} ${d1}, ${y1} – ${MONTH_SHORT[m2]} ${d2}, ${y2}`;
}
