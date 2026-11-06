import '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../db/index.js';
import { passwordVersion } from './adminPassword.js';

export type Role = 'teacher' | 'student' | 'admin';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: Role; studentId?: string; pwv?: string };
    user: { sub: string; role: Role; studentId?: string; pwv?: string };
  }
}

export async function requireSignedIn(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Please sign in again.' });
  }
  // Admin sessions end as soon as the admin password is changed or reset
  if (request.user.role === 'admin') {
    const result = await query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1 AND role = 'admin'`,
      [request.user.sub]
    );
    const row = result.rows[0];
    if (!row || request.user.pwv !== passwordVersion(row.password_hash)) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Your session ended. Please sign in again.' });
    }
  }
}

export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!roles.includes(request.user.role)) {
      return reply
        .code(403)
        .send({ error: 'Forbidden', message: 'This account can’t do that.' });
    }
  };
}