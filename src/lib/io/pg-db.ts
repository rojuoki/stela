import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { IoConfigurationError } from "./configuration-error";

let pool: Pool | null = null;

function connectionString(): string {
  const value = process.env.STELA_IO_DATABASE_URL;
  if (!value) {
    throw new IoConfigurationError(
      "STELA_IO_DATABASE_URL is not set. The IO database must not use DATABASE_URL.",
    );
  }
  return value;
}

function requiresSsl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.endsWith(".neon.tech")
      || url.searchParams.get("sslmode") === "require";
  } catch {
    return false;
  }
}

/** Dedicated pool for the independent IO product database. */
export function getIoPgPool(worker = false): Pool {
  if (!pool) {
    const value = connectionString();
    pool = new Pool({
      connectionString: value,
      ...(worker ? {
        connectionTimeoutMillis: 10_000,
        statement_timeout: 15_000,
        query_timeout: 20_000,
      } : {}),
      ssl: requiresSsl(value) ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

export async function ioPgQuery<T extends QueryResultRow = QueryResultRow>(
  query: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return getIoPgPool().query<T>(query, values);
}

export async function withIoPgTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getIoPgPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeIoPgPool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
