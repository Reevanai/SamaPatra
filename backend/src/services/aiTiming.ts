import { query } from '../db/index.js';

/**
 * Learns how long slow AI jobs take, so the apps can say "usually takes about 50 seconds"
 * and show a countdown instead of a spinner.
 *
 * Every finished job is recorded with its size (pages and bytes). An estimate for a new job is
 * the typical seconds-per-page (or per-MB) of recent jobs with the same provider, times its size.
 * Until there are a few recorded jobs, sensible starting guesses are used.
 */

export type TimedOperation = 'pdf_import';

interface Defaults {
  base: number; // seconds of fixed overhead
  perPage: number;
  perMb: number;
}

// Starting guesses before there is any history (tuned for typical 4–8 page question papers)
const DEFAULTS: Record<TimedOperation, Record<string, Defaults>> = {
  pdf_import: {
    gemini: { base: 12, perPage: 9, perMb: 18 },
    sarvam: { base: 8, perPage: 6, perMb: 12 },
  },
};

const HISTORY = 30; // recent jobs to learn from
const MIN_SAMPLES = 3; // below this, blend with the starting guess
const MIN_SECONDS = 5;

let tableReady: Promise<void> | undefined;
function ensureTable(): Promise<void> {
  tableReady ??= query(`
    CREATE TABLE IF NOT EXISTS ai_timings (
      id BIGSERIAL PRIMARY KEY,
      operation VARCHAR(40) NOT NULL,
      provider VARCHAR(20) NOT NULL,
      model VARCHAR(100),
      pages INTEGER,
      bytes INTEGER,
      seconds REAL NOT NULL,
      ok BOOLEAN NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_timings_lookup ON ai_timings (operation, provider, created_at DESC);
    ALTER TABLE ai_timings ENABLE ROW LEVEL SECURITY;`)
    .then(() => undefined)
    .catch((error) => {
      tableReady = undefined;
      throw error;
    });
  return tableReady;
}

/** Records a finished job. Never throws: timing must not break the real work. */
export async function recordTiming(entry: {
  operation: TimedOperation;
  provider: string;
  model?: string;
  pages?: number | null;
  bytes?: number | null;
  seconds: number;
  ok: boolean;
}): Promise<void> {
  try {
    await ensureTable();
    await query(
      `INSERT INTO ai_timings (operation, provider, model, pages, bytes, seconds, ok)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.operation, entry.provider, entry.model ?? null, entry.pages ?? null, entry.bytes ?? null, entry.seconds, entry.ok]
    );
  } catch (error) {
    console.error('Could not record AI timing:', (error as Error).message);
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface Estimate {
  seconds: number; // best guess
  low: number; // a quick run
  high: number; // a slow run
  basedOn: number; // how many past jobs it learned from
  provider: string;
}

/** How long a job of this size will probably take with the given provider. */
export async function estimateSeconds(input: {
  operation: TimedOperation;
  provider: string;
  pages?: number;
  bytes?: number;
}): Promise<Estimate> {
  const d = DEFAULTS[input.operation][input.provider] ?? DEFAULTS[input.operation].gemini;
  const pages = input.pages && input.pages > 0 ? input.pages : undefined;
  const mb = input.bytes && input.bytes > 0 ? input.bytes / (1024 * 1024) : undefined;
  const byPages = pages !== undefined;

  // Starting guess
  const guess = d.base + (byPages ? d.perPage * pages! : d.perMb * (mb ?? 1));

  let rates: number[] = [];
  try {
    await ensureTable();
    const r = await query<{ seconds: number; pages: number | null; bytes: number | null }>(
      `SELECT seconds, pages, bytes FROM ai_timings
       WHERE operation = $1 AND provider = $2 AND ok AND ${byPages ? 'pages > 0' : 'bytes > 0'}
       ORDER BY created_at DESC LIMIT $3`,
      [input.operation, input.provider, HISTORY]
    );
    // Seconds per unit of size for each past job (after the fixed overhead)
    rates = r.rows
      .map((row) => {
        const units = byPages ? row.pages! : row.bytes! / (1024 * 1024);
        return Math.max(0, row.seconds - d.base) / units;
      })
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b);
  } catch (error) {
    console.error('Could not read AI timings:', (error as Error).message);
  }

  const units = byPages ? pages! : mb ?? 1;
  let seconds = guess;
  let low = guess * 0.7;
  let high = guess * 1.5;
  if (rates.length > 0) {
    const fromHistory = (q: number) => d.base + quantile(rates, q) * units;
    // With little history, lean on the starting guess; with more, trust the history
    const weight = Math.min(1, rates.length / MIN_SAMPLES);
    seconds = weight * fromHistory(0.5) + (1 - weight) * guess;
    low = weight * fromHistory(0.2) + (1 - weight) * low;
    high = weight * fromHistory(0.85) + (1 - weight) * high;
  }

  const round = (x: number) => Math.max(MIN_SECONDS, Math.round(x));
  return {
    seconds: round(seconds),
    low: round(Math.min(low, seconds)),
    high: round(Math.max(high, seconds)),
    basedOn: rates.length,
    provider: input.provider,
  };
}
