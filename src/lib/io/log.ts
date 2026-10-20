type IoLogLevel = "info" | "warn" | "error";

function serialize(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

/** Emits one JSON object per line for Railway-compatible log search and alerts. */
export function ioLog(level: IoLogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    service: "stela-io",
    level,
    event,
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, serialize(value)])),
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.info(entry);
}
