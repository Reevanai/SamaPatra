import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { query } from '../db/index.js';
import { hashSecret, verifySecret } from './passwords.js';

// Letters only, without look-alikes (I, O, l), so the password is easy to read and type.
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const LENGTH = 24; // about 134 bits of randomness

export const ADMIN_EMAIL = 'admin@samapatra.internal';

/** A new random admin password, e.g. "kHqTzbWmRfaxNcyJupgEvDsK". */
export function generateAdminPassword(): string {
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += LETTERS[randomInt(LETTERS.length)];
  return out;
}

/** Short fingerprint of the stored hash. Put in admin tokens so a password change ends old sessions. */
export function passwordVersion(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 16);
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface AdminRow {
  id: string;
  name: string;
  password_hash: string;
}

export async function listAdmins(): Promise<AdminRow[]> {
  const result = await query<AdminRow>(
    `SELECT id, name, password_hash FROM users WHERE role = 'admin' ORDER BY created_at`
  );
  return result.rows;
}

/** The admin whose password this is, or null. */
export async function findAdminByPassword(password: string): Promise<AdminRow | null> {
  for (const admin of await listAdmins()) {
    if (await verifySecret(password, admin.password_hash)) return admin;
  }
  return null;
}

/**
 * Gives the admin a new random password (creating the admin if there is none yet).
 * Returns the plain password (shown once) and the new hash.
 */
export async function issueNewAdminPassword(
  adminId?: string
): Promise<{ id: string; name: string; password: string; passwordHash: string; created: boolean }> {
  const password = generateAdminPassword();
  const passwordHash = await hashSecret(password);
  let id = adminId;
  if (!id) id = (await listAdmins())[0]?.id;
  if (id) {
    const result = await query<{ id: string; name: string }>(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 AND role = 'admin' RETURNING id, name`,
      [passwordHash, id]
    );
    if (result.rows[0]) return { ...result.rows[0], password, passwordHash, created: false };
  }
  const result = await query<{ id: string; name: string }>(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, 'Admin', 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', updated_at = NOW()
     RETURNING id, name`,
    [ADMIN_EMAIL, passwordHash]
  );
  return { ...result.rows[0], password, passwordHash, created: true };
}

/** The recovery code from the server settings (also used to create the first admin). */
export function recoveryCode(): string | undefined {
  return (process.env.ADMIN_RECOVERY_CODE || process.env.ADMIN_SETUP_CODE || '').trim() || undefined;
}
