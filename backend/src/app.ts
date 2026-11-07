import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { pool } from './db/index.js';
import jwt from '@fastify/jwt';
import authRoutes from './routes/auth.js';
import rosterRoutes from './routes/roster.js';
import { requireSignedIn, requireRole } from './auth/guards.js';
import meRoutes from './routes/me.js';
import classPapersRoutes from './routes/classPapers.js';

// Import routes
import questionRoutes from './routes/questions.js';
import adaptiveTestRoutes from './routes/adaptiveTest.js';
import paperRoutes from './routes/papers.js';
import gradingRoutes from './routes/grading.js';
import studentRoutes from './routes/students.js';
import classRoutes from './routes/classes.js';
import bankRoutes from './routes/bank.js';
import adminRoutes, { adminSettingsRoutes } from './routes/admin.js';
import adminManageRoutes from './routes/adminManage.js';
import aiEstimateRoutes from './routes/aiEstimate.js';

/** Builds the API. Used by server.ts (normal server) and api/index.ts (Vercel). */
export async function buildApp(): Promise<FastifyInstance> {
  const server = Fastify({
    // Set TRUST_PROXY=true when running behind a proxy (Render, Railway, nginx...) so
    // sign-in lockouts see the real client IP.
    trustProxy: process.env.TRUST_PROXY === 'true' || process.env.VERCEL === '1',
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
    },
  });

  // Register plugins
  // CORS_ORIGIN can be one origin or a comma-separated list
  // (for example the admin panel's Vercel URL). Default "*" keeps the Android app working.
  const corsOrigins = (process.env.CORS_ORIGIN || '*')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await server.register(cors, {
    origin: corsOrigins.includes('*') ? '*' : corsOrigins,
    credentials: !corsOrigins.includes('*'),
  });

  await server.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB for PDF uploads
    },
  });
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET is missing or too short. Add a random 32+ character value to .env');
  }
  await server.register(jwt, { secret: jwtSecret });

  // Register routes
  // Public: sign up and sign in
  await server.register(authRoutes, { prefix: '/api' });
  await server.register(adminRoutes, { prefix: '/api' });

  // Everything else needs a signed-in user
  await server.register(
    async (app) => {
      app.addHook('onRequest', requireSignedIn);

      // Teachers and students
      await app.register(adaptiveTestRoutes);
      await app.register(paperRoutes);
      await app.register(studentRoutes);
      await app.register(meRoutes);

      // Teachers only
      await app.register(async (teacherApp) => {
        teacherApp.addHook('onRequest', requireRole('teacher', 'admin'));
        await teacherApp.register(questionRoutes);
        await teacherApp.register(gradingRoutes);
        await teacherApp.register(classRoutes);
        await teacherApp.register(rosterRoutes);
        await teacherApp.register(classPapersRoutes);
        await teacherApp.register(bankRoutes);
      await teacherApp.register(aiEstimateRoutes);
      });

      // Admins only: API keys and AI settings
      await app.register(async (adminApp) => {
        adminApp.addHook('onRequest', requireRole('admin'));
        await adminApp.register(adminSettingsRoutes);
      await adminApp.register(adminManageRoutes);
      });
    },
    { prefix: '/api' }
  );

  // Health check
  server.get('/health', async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', timestamp: new Date().toISOString() };
    } catch (error) {
      reply.code(503);
      return { status: 'error', error: 'Database unavailable' };
    }
  });

  // Root route
  server.get('/', async (request, reply) => {
    return {
      name: 'SamaPatra API',
      version: '1.0.0',
      description: 'Inclusive exam platform for students with diverse learning needs',
    };
  });

  // Error handler
  server.setErrorHandler((error: FastifyError, request, reply) => {
    server.log.error(error);

    const statusCode = error.statusCode || 500;
    reply.code(statusCode).send({
      error: error.name,
      message: error.message,
      statusCode,
    });
  });

  return server;
}
