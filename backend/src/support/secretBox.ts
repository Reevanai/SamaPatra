import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts secrets (like API keys) before they go into the database, using AES-256-GCM.
 *
 * The key comes from SETTINGS_ENCRYPTION_KEY (64 hex characters = 32 bytes).
 * If that is not set, a key is derived from JWT_SECRET, so it still works out of the box,
 * but then changing JWT_SECRET makes saved keys unreadable (you would just re-enter them).
 */
let cachedKey: Buffer | undefined;

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (raw) {
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error('SETTINGS_ENCRYPTION_KEY must be 64 hex characters (run: openssl rand -hex 32)');
    }
    cachedKey = Buffer.from(raw, 'hex');
  } else {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET is required');
    console.warn('SETTINGS_ENCRYPTION_KEY is not set. Deriving the settings key from JWT_SECRET.');
    cachedKey = Buffer.from(hkdfSync('sha256', jwtSecret, 'samapatra-settings', 'api-keys', 32));
  }
  return cachedKey;
}

/** Returns "v1:<iv>:<tag>:<ciphertext>", all base64. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || dataB64 === undefined) {
    throw new Error('Unknown secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** "AIza…1234" style preview, safe to show in the admin panel. */
export function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
