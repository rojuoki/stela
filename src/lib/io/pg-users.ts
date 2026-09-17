import { randomUUID } from "node:crypto";
import { ioPgQuery } from "./pg-db";

export interface IoUser {
  id: string;
  email: string;
  name: string;
}

interface IoUserWithPassword extends IoUser {
  password_hash: string;
}

export interface IoUnlockBoundary {
  user_id: string;
  account_id: string;
  boundary_end: number;
  source_run_id: string | null;
  unlocked_at: string;
}

export async function createIoUser(
  email: string,
  passwordHash: string,
  name: string,
): Promise<IoUser | null> {
  const normalizedEmail = email.trim().toLowerCase();
  const result = await ioPgQuery<IoUser>(
    `INSERT INTO users (id, email, name, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING id, email, name`,
    [randomUUID(), normalizedEmail, name.trim(), passwordHash],
  );
  return result.rows[0] ?? null;
}

export async function getIoUserByEmail(email: string): Promise<IoUserWithPassword | null> {
  const result = await ioPgQuery<IoUserWithPassword>(
    `SELECT id, email, name, password_hash
     FROM users WHERE LOWER(email) = LOWER($1)`,
    [email.trim()],
  );
  return result.rows[0] ?? null;
}

export async function getIoUserById(id: string): Promise<IoUser | null> {
  const result = await ioPgQuery<IoUser>(
    "SELECT id, email, name FROM users WHERE id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getIoUnlockBoundary(
  userId: string,
  accountId: string,
): Promise<number> {
  const result = await ioPgQuery<{ boundary_end: number }>(
    `SELECT boundary_end FROM user_unlocks
     WHERE user_id = $1 AND account_id = $2`,
    [userId, accountId],
  );
  return Number(result.rows[0]?.boundary_end ?? 0);
}

/** Boundary writes are monotonic, matching the old product's unlock contract. */
export async function upsertIoUnlockBoundary(
  userId: string,
  accountId: string,
  boundaryEnd: number,
  sourceRunId: string | null,
): Promise<number> {
  if (!Number.isInteger(boundaryEnd) || boundaryEnd <= 0) {
    throw new Error("Unlock boundary must be a positive integer");
  }
  const result = await ioPgQuery<{ boundary_end: number }>(
    `INSERT INTO user_unlocks (user_id, account_id, boundary_end, source_run_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, account_id) DO UPDATE SET
       boundary_end = GREATEST(user_unlocks.boundary_end, EXCLUDED.boundary_end),
       source_run_id = CASE
         WHEN EXCLUDED.boundary_end > user_unlocks.boundary_end
         THEN EXCLUDED.source_run_id ELSE user_unlocks.source_run_id END,
       unlocked_at = CASE
         WHEN EXCLUDED.boundary_end > user_unlocks.boundary_end
         THEN NOW() ELSE user_unlocks.unlocked_at END
     RETURNING boundary_end`,
    [userId, accountId, boundaryEnd, sourceRunId],
  );
  return Number(result.rows[0]?.boundary_end ?? boundaryEnd);
}
