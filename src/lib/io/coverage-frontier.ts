export interface IoCoverageInterval {
  startAt: string;
  endAt: string;
}

export interface IoCoverageFrontier {
  startsAt: string;
  frontierAt: string;
  completeWindowCount: number;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Finds the exclusive end of the complete, gap-free coverage prefix. */
export function computeIoCoverageFrontier(
  accountCreatedAt: string,
  windows: readonly IoCoverageInterval[],
): IoCoverageFrontier | null {
  const startsAt = timestamp(accountCreatedAt);
  if (startsAt == null) return null;

  let frontier = startsAt;
  let completeWindowCount = 0;
  const sorted = windows
    .map((window) => ({ start: timestamp(window.startAt), end: timestamp(window.endAt) }))
    .filter((window): window is { start: number; end: number } =>
      window.start != null && window.end != null && window.start < window.end,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);

  for (const window of sorted) {
    if (window.end <= frontier) continue;
    if (window.start > frontier) break;
    frontier = window.end;
    completeWindowCount += 1;
  }
  return {
    startsAt: new Date(startsAt).toISOString(),
    frontierAt: new Date(frontier).toISOString(),
    completeWindowCount,
  };
}
