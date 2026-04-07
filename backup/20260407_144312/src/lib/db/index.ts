import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

// ========================================
// POSTGRES CONNECTION LAYER
// ========================================

let _pgPool: Pool | null = null;

/**
 * Get Postgres connection pool using DATABASE_URL.
 */
export function getPgPool(): Pool {
  if (!_pgPool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is not set for Postgres connection");
    }
    
    _pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    
    console.log("[postgres] Connection pool initialized");
  }
  return _pgPool;
}

/**
 * Execute a parameterized Postgres query.
 */
export async function pgQuery<T extends QueryResultRow = any>(
  text: string,
  params: any[] = []
): Promise<QueryResult<T>> {
  const pool = getPgPool();
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    console.error("[postgres] Query error:", error);
    console.error("[postgres] Query:", text);
    console.error("[postgres] Params:", params);
    throw error;
  }
}

/**
 * Test Postgres connectivity.
 */
export async function testPgConnection(): Promise<boolean> {
  try {
    const result = await pgQuery("SELECT 1 as test");
    console.log("[postgres] Connection test successful:", result.rows[0]);
    return true;
  } catch (error) {
    console.error("[postgres] Connection test failed:", error);
    return false;
  }
}
