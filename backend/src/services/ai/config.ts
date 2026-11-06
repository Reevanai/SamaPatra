import { query } from '../../db/index.js';
import { decryptSecret, encryptSecret } from '../../support/secretBox.js';

export type ProviderName = 'sarvam' | 'gemini';

/** Everything the AI layer needs. Saved values (admin panel) win over .env values. */
export interface AIConfigValues {
  textProvider: ProviderName; // translation, grading, adapting questions
  pdfProvider: ProviderName; // reading question paper PDFs
  sarvamApiKey?: string;
  sarvamModel: string;
  sarvamFallbackModel?: string;
  geminiApiKey?: string;
  geminiModel: string;
  geminiFallbackModel?: string;
}

export const SECRET_FIELDS = ['sarvamApiKey', 'geminiApiKey'] as const;
export const PLAIN_FIELDS = [
  'textProvider',
  'pdfProvider',
  'sarvamModel',
  'sarvamFallbackModel',
  'geminiModel',
  'geminiFallbackModel',
] as const;
export type SettingField = (typeof SECRET_FIELDS)[number] | (typeof PLAIN_FIELDS)[number];

function asProvider(value: string | undefined, fallback: ProviderName): ProviderName {
  return value === 'sarvam' || value === 'gemini' ? value : fallback;
}

function optional(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && v.toLowerCase() !== 'none' ? v : undefined;
}

/** Values from .env only. */
export function envConfig(): AIConfigValues {
  const env = process.env;
  return {
    textProvider: asProvider(env.AI_TEXT_PROVIDER, 'sarvam'),
    pdfProvider: asProvider(env.AI_PDF_PROVIDER, 'gemini'),
    sarvamApiKey: optional(env.SARVAM_API_KEY),
    sarvamModel: optional(env.SARVAM_MODEL) ?? 'sarvam-m',
    sarvamFallbackModel: optional(env.SARVAM_FALLBACK_MODEL),
    geminiApiKey: optional(env.GOOGLE_AI_API_KEY),
    geminiModel: optional(env.GOOGLE_AI_MODEL) ?? 'gemini-3.5-flash',
    geminiFallbackModel:
      env.GOOGLE_AI_FALLBACK_MODEL === undefined
        ? 'gemini-3.1-flash-lite'
        : optional(env.GOOGLE_AI_FALLBACK_MODEL),
  };
}

let tableReady: Promise<void> | undefined;
export function ensureSettingsTable(): Promise<void> {
  tableReady ??= query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      is_secret BOOLEAN NOT NULL DEFAULT false,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).then(() => undefined)
    .catch((error) => {
      tableReady = undefined;
      throw error;
    });
  return tableReady;
}

interface StoredRow {
  key: string;
  value: string;
  is_secret: boolean;
  updated_at: Date;
  updated_by_name: string | null;
}

async function loadStored(): Promise<StoredRow[]> {
  await ensureSettingsTable();
  const result = await query<StoredRow>(
    `SELECT s.key, s.value, s.is_secret, s.updated_at, u.name AS updated_by_name
     FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by
     WHERE s.key LIKE 'ai.%'`
  );
  return result.rows;
}

const CACHE_MS = 30_000;
let cached: { at: number; value: AIConfigValues } | undefined;

/** The live AI settings. Cached briefly; saving from the admin panel clears the cache. */
export async function getAIConfig(): Promise<AIConfigValues> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const config = envConfig();
  try {
    for (const row of await loadStored()) {
      const field = row.key.slice(3) as SettingField;
      let value: string;
      try {
        value = row.is_secret ? decryptSecret(row.value) : row.value;
      } catch {
        console.error(`Could not decrypt saved setting ${row.key}. Re-enter it in the admin panel.`);
        continue;
      }
      if (field === 'textProvider' || field === 'pdfProvider') {
        config[field] = asProvider(value, config[field]);
      } else if ((SECRET_FIELDS as readonly string[]).includes(field) || (PLAIN_FIELDS as readonly string[]).includes(field)) {
        (config as unknown as Record<string, string | undefined>)[field] = optional(value);
      }
    }
    // A model name must never be blank
    config.sarvamModel ||= 'sarvam-m';
    config.geminiModel ||= 'gemini-3.5-flash';
  } catch (error) {
    console.error('Could not read saved AI settings, using .env values:', (error as Error).message);
  }

  cached = { at: Date.now(), value: config };
  return config;
}

export function clearAIConfigCache(): void {
  cached = undefined;
}

/** What the admin panel shows: where each value comes from, without revealing keys. */
export async function describeStored(): Promise<
  Record<string, { source: 'saved' | 'env' | 'default'; updatedAt?: string; updatedBy?: string | null }>
> {
  const rows = await loadStored();
  const env = process.env;
  const envNames: Record<SettingField, string> = {
    textProvider: 'AI_TEXT_PROVIDER',
    pdfProvider: 'AI_PDF_PROVIDER',
    sarvamApiKey: 'SARVAM_API_KEY',
    sarvamModel: 'SARVAM_MODEL',
    sarvamFallbackModel: 'SARVAM_FALLBACK_MODEL',
    geminiApiKey: 'GOOGLE_AI_API_KEY',
    geminiModel: 'GOOGLE_AI_MODEL',
    geminiFallbackModel: 'GOOGLE_AI_FALLBACK_MODEL',
  };
  const out: Record<string, { source: 'saved' | 'env' | 'default'; updatedAt?: string; updatedBy?: string | null }> = {};
  for (const field of [...SECRET_FIELDS, ...PLAIN_FIELDS]) {
    const row = rows.find((r) => r.key === `ai.${field}`);
    out[field] = row
      ? { source: 'saved', updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by_name }
      : { source: env[envNames[field]] ? 'env' : 'default' };
  }
  return out;
}

/**
 * Saves settings. A value of null removes the saved value (falls back to .env).
 * Secrets are encrypted before they are stored.
 */
export async function saveSettings(
  changes: Partial<Record<SettingField, string | null>>,
  userId: string
): Promise<void> {
  await ensureSettingsTable();
  for (const [field, value] of Object.entries(changes) as [SettingField, string | null | undefined][]) {
    if (value === undefined) continue;
    const key = `ai.${field}`;
    if (value === null) {
      await query('DELETE FROM app_settings WHERE key = $1', [key]);
      continue;
    }
    const isSecret = (SECRET_FIELDS as readonly string[]).includes(field);
    await query(
      `INSERT INTO app_settings (key, value, is_secret, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret,
           updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
      [key, isSecret ? encryptSecret(value) : value, isSecret, userId]
    );
  }
  clearAIConfigCache();
}
