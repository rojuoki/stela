// PostgreSQL text/jsonb cannot store NUL, and legacy social posts can contain
// other non-printing C0 bytes. Preserve normal whitespace while removing the
// bytes that have no useful display value and can break persistence.
const unsafeControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function sanitizeIoPostgresText(value: string): string {
  return value.replace(unsafeControlCharacters, "");
}

export function stringifyIoPostgresJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, current) =>
    typeof current === "string" ? sanitizeIoPostgresText(current) : current);
  if (serialized === undefined) throw new Error("Value cannot be serialized as JSON");
  return serialized;
}
