import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/index.js';
import { hashSecret, verifySecret } from '../auth/passwords.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { clearFailures, recordFailure, secondsLocked } from '../auth/lockout.js';
import {
  describeStored,
  envConfig,
  getAIConfig,
  saveSettings,
  type AIConfigValues,
  type ProviderName,
} from '../services/ai/config.js';
import { buildProvider } from '../services/ai/providers.js';
import { maskSecret } from '../support/secretBox.js';

// Admin sign-in is stricter than teacher sign-in: 5 wrong tries per email OR per IP
// locks for 15 minutes. Stored in the database, so it holds on serverless hosts too.
const ADMIN_LOCKOUT = { maxTries: 5, lockMs: 15 * 60 * 1000 };
const ADMIN_TOKEN_TTL = '1h';

// Used when the email does not exist, so a wrong email takes as long as a wrong password.
const DUMMY_HASH =
  'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);

const SetupSchema = z.object({
  setupCode: z.string().min(1).max(200),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(12).max(128),
});

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function adminExists(): Promise<boolean> {
  const result = await query(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`);
  return result.rows.length > 0;
}

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(128),
});

const provider = z.enum(['sarvam', 'gemini']);
const modelName = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:\/-]+$/, 'Invalid model name');
const apiKey = z.string().trim().min(8).max(500).regex(/^\S+$/, 'API keys cannot contain spaces');

// Each field: leave it out = no change, null = remove the saved value (use .env).
const UpdateSchema = z
  .object({
    textProvider: provider.nullable().optional(),
    pdfProvider: provider.nullable().optional(),
    sarvamApiKey: apiKey.nullable().optional(),
    sarvamModel: modelName.nullable().optional(),
    sarvamFallbackModel: modelName.or(z.literal('')).nullable().optional(),
    geminiApiKey: apiKey.nullable().optional(),
    geminiModel: modelName.nullable().optional(),
    geminiFallbackModel: modelName.or(z.literal('')).nullable().optional(),
  })
  .strict();

const TestSchema = z
  .object({
    provider,
    // Optional: test a key before saving it. Otherwise the saved key is tested.
    apiKey: apiKey.optional(),
    model: modelName.optional(),
  })
  .strict();

async function publicView() {
  const config = await getAIConfig();
  const sources = await describeStored();
  return {
    textProvider: config.textProvider,
    pdfProvider: config.pdfProvider,
    sarvam: {
      apiKey: maskSecret(config.sarvamApiKey),
      model: config.sarvamModel,
      fallbackModel: config.sarvamFallbackModel ?? '',
    },
    gemini: {
      apiKey: maskSecret(config.geminiApiKey),
      model: config.geminiModel,
      fallbackModel: config.geminiFallbackModel ?? '',
    },
    sources,
  };
}

export default async function adminRoutes(fastify: FastifyInstance) {
  // Public: is first-time setup still open? (Only before any admin exists.)
  fastify.get('/auth/admin/setup', async () => ({
    open: Boolean(process.env.ADMIN_SETUP_CODE) && !(await adminExists()),
  }));

  // Public: create the FIRST admin with ADMIN_SETUP_CODE. Closed for good once an admin exists.
  fastify.post('/auth/admin/setup', async (request, reply) => {
    const ipKey = `admin-setup-ip:${request.ip}`;
    const wait = await secondsLocked(ipKey);
    if (wait > 0) {
      reply.code(429);
      return { error: 'Too many tries', message: `Too many wrong tries. Try again in ${Math.ceil(wait / 60)} minutes.` };
    }
    const parsed = SetupSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request', message: 'Fill in every field. The password needs at least 12 characters.' };
    }
    const expected = process.env.ADMIN_SETUP_CODE;
    if (!expected || (await adminExists())) {
      reply.code(403);
      return { error: 'Setup closed', message: 'An admin already exists. Sign in instead.' };
    }
    const { setupCode, name, email, password } = parsed.data;
    if (!safeEqual(setupCode, expected)) {
      await recordFailure(ipKey, ADMIN_LOCKOUT);
      reply.code(403);
      return { error: 'Wrong code', message: 'That setup code is not right.' };
    }
    const taken = await query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (taken.rows.length > 0) {
      reply.code(409);
      return { error: 'Email in use', message: 'That email already belongs to another account. Use a different one.' };
    }
    const result = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'admin') RETURNING id`,
      [email, await hashSecret(password), name]
    );
    const id = result.rows[0].id;
    request.log.warn({ adminId: id, ip: request.ip }, 'First admin created through setup');
    const token = fastify.jwt.sign({ sub: id, role: 'admin' }, { expiresIn: ADMIN_TOKEN_TTL });
    reply.code(201);
    return { token, expiresIn: 3600, user: { id, name, email, role: 'admin' } };
  });

  // Public: admin sign-in
  fastify.post('/auth/admin/login', async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request', message: 'Enter your email and password.' };
    }
    const { email, password } = parsed.data;
    const emailKey = `admin:${email}`;
    const ipKey = `admin-ip:${request.ip}`;
    const wait = Math.max(await secondsLocked(emailKey), await secondsLocked(ipKey));
    if (wait > 0) {
      reply.code(429);
      return {
        error: 'Too many tries',
        message: `Too many wrong tries. Try again in ${Math.ceil(wait / 60)} minutes.`,
      };
    }

    const result = await query<{ id: string; name: string; password_hash: string }>(
      `SELECT id, name, password_hash FROM users WHERE email = $1 AND role = 'admin'`,
      [email]
    );
    const row = result.rows[0];
    const ok = await verifySecret(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok) {
      await recordFailure(emailKey, ADMIN_LOCKOUT);
      await recordFailure(ipKey, ADMIN_LOCKOUT);
      request.log.warn({ email, ip: request.ip }, 'Failed admin sign-in');
      reply.code(401);
      return { error: 'Wrong details', message: 'That email or password is not right.' };
    }

    await clearFailures(emailKey, ipKey);
    request.log.info({ adminId: row.id, ip: request.ip }, 'Admin signed in');
    const token = fastify.jwt.sign({ sub: row.id, role: 'admin' }, { expiresIn: ADMIN_TOKEN_TTL });
    return { token, expiresIn: 3600, user: { id: row.id, name: row.name, email, role: 'admin' } };
  });
}

/** Routes here must be registered behind requireSignedIn + requireRole('admin'). */
export async function adminSettingsRoutes(fastify: FastifyInstance) {
  // Never cache admin responses anywhere
  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  fastify.get('/admin/me', async (request) => {
    const result = await query<{ name: string; email: string }>(
      'SELECT name, email FROM users WHERE id = $1',
      [request.user.sub]
    );
    return { id: request.user.sub, role: request.user.role, ...result.rows[0] };
  });

  fastify.get('/admin/ai-settings', async () => publicView());

  fastify.put('/admin/ai-settings', async (request, reply) => {
    const parsed = UpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    const changes = Object.fromEntries(
      Object.entries(parsed.data).map(([k, v]) => [k, v === '' ? 'none' : v])
    );
    await saveSettings(changes, request.user.sub);
    request.log.info(
      { adminId: request.user.sub, fields: Object.keys(changes) },
      'Admin changed AI settings'
    );
    return publicView();
  });

  // Sends a tiny prompt to check that a key and model work.
  fastify.post('/admin/ai-settings/test', async (request, reply) => {
    const parsed = TestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request', message: 'Choose sarvam or gemini.' };
    }
    const { provider: name, apiKey: key, model } = parsed.data;
    const config: AIConfigValues = { ...(await getAIConfig()) };
    if (name === 'sarvam') {
      if (key) config.sarvamApiKey = key;
      if (model) config.sarvamModel = model;
      config.sarvamFallbackModel = undefined;
    } else {
      if (key) config.geminiApiKey = key;
      if (model) config.geminiModel = model;
      config.geminiFallbackModel = undefined;
    }

    const started = Date.now();
    try {
      const p = buildProvider(name as ProviderName, config);
      const answer = await p.generateText('Reply with just the word OK.', {
        temperature: 0,
        maxTokens: 512,
      });
      return {
        ok: true,
        provider: name,
        model: p.modelName,
        ms: Date.now() - started,
        reply: answer.slice(0, 80),
      };
    } catch (error) {
      const message = (error as Error).message ?? 'Unknown error';
      // Make sure a key never ends up in the response
      const secrets = [config.sarvamApiKey, config.geminiApiKey].filter(Boolean) as string[];
      const safe = secrets.reduce((m, s) => m.split(s).join('••••'), message);
      return { ok: false, provider: name, ms: Date.now() - started, message: safe.slice(0, 400) };
    }
  });

  // What .env alone would give, so the admin can see what "reset" would do
  fastify.get('/admin/ai-settings/env-defaults', async () => {
    const env = envConfig();
    return {
      textProvider: env.textProvider,
      pdfProvider: env.pdfProvider,
      sarvamModel: env.sarvamModel,
      geminiModel: env.geminiModel,
      sarvamApiKey: maskSecret(env.sarvamApiKey),
      geminiApiKey: maskSecret(env.geminiApiKey),
    };
  });
}
