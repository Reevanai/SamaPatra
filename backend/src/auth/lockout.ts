import { query } from '../db/index.js';

/**
 * Wrong-password lockouts, kept in the database so they hold across server restarts
 * and across the many short-lived instances a serverless host (like Vercel) runs.
 */
let tableReady: Promise<void> | undefined;
function ensureTable(): Promise<void> {
  tableReady ??= query(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      key VARCHAR(320) PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMP WITH TIME ZONE,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).then(() => undefined)
    .catch((error) => {
      tableReady = undefined;
      throw error;
    });
  return tableReady;
}

export interface LockoutPolicy {
  maxTries: number;
  lockMs: number;
}

/** Seconds until the key is unlocked (0 if not locked). */
export async function secondsLocked(key: string): Promise<number> {
  await ensureTable();
  const result = await query<{ seconds: number }>(
    `SELECT CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())))::int AS seconds
     FROM login_attempts WHERE key = $1 AND locked_until > NOW()`,
    [key]
  );
  return result.rows[0]?.seconds ?? 0;
}

/** Counts a wrong try. After maxTries in a row, locks the key for lockMs. */
export async function recordFailure(key: string, policy: LockoutPolicy): Promise<void> {
  await ensureTable();
  await query(
    `INSERT INTO login_attempts (key, failures, updated_at) VALUES ($1, 1, NOW())
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN login_attempts.failures + 1 >= $2 THEN 0 ELSE login_attempts.failures + 1 END,
       locked_until = CASE WHEN login_attempts.failures + 1 >= $2
                           THEN NOW() + ($3 || ' milliseconds')::interval
                           ELSE login_attempts.locked_until END,
       updated_at = NOW()`,
    [key, policy.maxTries, String(policy.lockMs)]
  );
}

export async function clearFailures(...keys: string[]): Promise<void> {
  await ensureTable();
  await query('DELETE FROM login_attempts WHERE key = ANY($1)', [keys]);
}
