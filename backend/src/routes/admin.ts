import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/index.js';
import { verifySecret } from '../auth/passwords.js';
import {
  findAdminByPassword,
  issueNewAdminPassword,
  passwordVersion,
  recoveryCode,
  safeEqual,
} from '../auth/adminPassword.js';
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

// 5 wrong tries from one network address lock admin sign-in (and recovery) there for
// 15 minutes. Stored in the database, so it holds on serverless hosts too.
const ADMIN_LOCKOUT = { maxTries: 5, lockMs: 15 * 60 * 1000 };
const ADMIN_TOKEN_TTL = '1h';

const LoginSchema = z.object({ password: z.string().trim().min(1).max(128) }).strict();
const RecoverSchema = z.object({ recoveryCode: z.string().trim().min(1).max(200) }).strict();
const ChangeSchema = z.object({ currentPassword: z.string().trim().min(1).max(128) }).strict();

function lockedMessage(seconds: number) {
  return { error: 'Too many tries', message: `Too many wrong tries. Try again in ${Math.ceil(seconds / 60)} minutes.` };
}

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
  const signToken = (id: string, passwordHash: string) =>
    fastify.jwt.sign({ sub: id, role: 'admin', pwv: passwordVersion(passwordHash) }, { expiresIn: ADMIN_TOKEN_TTL });

  // Public: admin sign-in with the admin password only
  fastify.post('/auth/admin/login', async (request, reply) => {
    const ipKey = `admin-ip:${request.ip}`;
    const wait = await secondsLocked(ipKey);
    if (wait > 0) {
      reply.code(429);
      return lockedMessage(wait);
    }
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request', message: 'Enter the admin password.' };
    }
    const admin = await findAdminByPassword(parsed.data.password);
    if (!admin) {
      await recordFailure(ipKey, ADMIN_LOCKOUT);
      request.log.warn({ ip: request.ip }, 'Failed admin sign-in');
      reply.code(401);
      return { error: 'Wrong password', message: 'That password is not right.' };
    }
    await clearFailures(ipKey);
    request.log.info({ adminId: admin.id, ip: request.ip }, 'Admin signed in');
    return { token: signToken(admin.id, admin.password_hash), expiresIn: 3600, user: { id: admin.id, name: admin.name, role: 'admin' } };
  });

  // Public: forgot the password (or first-time setup). The recovery code from the server
  // settings gives the admin a new random password, shown once. Old sessions stop working.
  fastify.post('/auth/admin/recover', async (request, reply) => {
    const ipKey = `admin-recover-ip:${request.ip}`;
    const wait = await secondsLocked(ipKey);
    if (wait > 0) {
      reply.code(429);
      return lockedMessage(wait);
    }
    const parsed = RecoverSchema.safeParse(request.body);
    const expected = recoveryCode();
    if (!expected) {
      reply.code(403);
      return { error: 'Recovery off', message: 'No recovery code is set on the server (ADMIN_RECOVERY_CODE).' };
    }
    if (!parsed.success || !safeEqual(parsed.data.recoveryCode, expected)) {
      await recordFailure(ipKey, ADMIN_LOCKOUT);
      request.log.warn({ ip: request.ip }, 'Wrong admin recovery code');
      reply.code(403);
      return { error: 'Wrong code', message: 'That recovery code is not right.' };
    }
    await clearFailures(ipKey, `admin-ip:${request.ip}`);
    const result = await issueNewAdminPassword();
    request.log.warn({ adminId: result.id, ip: request.ip, created: result.created }, 'Admin password reset with recovery code');
    return {
      password: result.password,
      created: result.created,
      token: signToken(result.id, result.passwordHash),
      expiresIn: 3600,
      user: { id: result.id, name: result.name, role: 'admin' },
    };
  });
}

/** Routes here must be registered behind requireSignedIn + requireRole('admin'). */
export async function adminSettingsRoutes(fastify: FastifyInstance) {
  // Never cache admin responses anywhere
  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  // Change password: confirm the current one, get a new random one (shown once)
  fastify.post('/admin/password', async (request, reply) => {
    const parsed = ChangeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request', message: 'Enter your current password.' };
    }
    const current = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [request.user.sub]
    );
    if (!current.rows[0] || !(await verifySecret(parsed.data.currentPassword, current.rows[0].password_hash))) {
      await recordFailure(`admin-ip:${request.ip}`, ADMIN_LOCKOUT);
      reply.code(403);
      return { error: 'Wrong password', message: 'Your current password is not right.' };
    }
    const result = await issueNewAdminPassword(request.user.sub);
    request.log.warn({ adminId: request.user.sub }, 'Admin changed password');
    return {
      password: result.password,
      token: fastify.jwt.sign(
        { sub: result.id, role: 'admin', pwv: passwordVersion(result.passwordHash) },
        { expiresIn: ADMIN_TOKEN_TTL }
      ),
      expiresIn: 3600,
    };
  });

  fastify.get('/admin/me', async (request) => {
    const result = await query<{ name: string }>('SELECT name FROM users WHERE id = $1', [request.user.sub]);
    return { id: request.user.sub, role: request.user.role, name: result.rows[0]?.name ?? 'Admin' };
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
