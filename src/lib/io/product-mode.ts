/**
 * The existing SQLite prototype stays usable until a deliberate cutover.
 * Production must set this explicitly; STELA_IO_DATABASE_URL alone is never a
 * reason to silently redirect prototype traffic to a different database.
 */
export function ioProductModeEnabled(): boolean {
  return process.env.STELA_IO_USE_POSTGRES === "1";
}
