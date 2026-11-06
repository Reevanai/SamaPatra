import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { query } from '../db/index.js';
import { hashSecret, verifySecret } from '../auth/passwords.js';
import { clearFailures, recordFailure, secondsLocked } from '../auth/lockout.js';
import { effectiveSettings } from '../support/settings.js';

// Five wrong tries locks that account for five minutes (stored in the database).
const LOCKOUT = { maxTries: 5, lockMs: 5 * 60 * 1000 };

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const TeacherRegisterSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8).max(128),
  signupCode: z.string().min(1).max(100),
});

const TeacherLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(128),
});

const ClassCodeSchema = z.string().trim().toUpperCase().length(6);

const StudentLoginSchema = z.object({
  classCode: ClassCodeSchema,
  studentId: z.string().uuid(),
  pin: z.string().regex(/^\d{4}$/),
});

export default async function authRoutes(fastify: FastifyInstance) {
  // Teacher sign-up (needs the school code from .env)
  fastify.post('/auth/teacher/register', async (request, reply) => {
    const parsed = TeacherRegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Invalid request',
        message: 'Check your details. The password needs at least 8 characters.',
      };
    }
    const { name, email, password, signupCode } = parsed.data;

    const expected = process.env.TEACHER_SIGNUP_CODE;
    if (!expected) {
      reply.code(403);
      return { error: 'Sign-up closed', message: 'Teacher sign-up is turned off.' };
    }
    if (!safeEqual(signupCode, expected)) {
      reply.code(403);
      return { error: 'Wrong code', message: 'That school code is not right.' };
    }

    try {
      const passwordHash = await hashSecret(password);
      const result = await query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1, $2, $3, 'teacher')
         RETURNING id`,
        [email, passwordHash, name]
      );
      const id = result.rows[0].id;
      const token = fastify.jwt.sign({ sub: id, role: 'teacher' }, { expiresIn: '24h' });
      reply.code(201);
      return { token, user: { id, name, email, role: 'teacher' } };
    } catch (error: any) {
      if (error.code === '23505') {
        reply.code(409);
        return { error: 'Email in use', message: 'There is already an account with that email.' };
      }
      throw error;
    }
  });

  // Teacher sign-in
  fastify.post('/auth/teacher/login', async (request, reply) => {
    const parsed = TeacherLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request', message: 'Enter your email and password.' };
    }
    const { email, password } = parsed.data;

    const key = `teacher:${email}`;
    const wait = await secondsLocked(key);
    if (wait > 0) {
      reply.code(429);
      return {
        error: 'Too many tries',
        message: `Too many wrong tries. Try again in ${Math.ceil(wait / 60)} minutes.`,
      };
    }

    const result = await query<{ id: string; name: string; password_hash: string }>(
      `SELECT id, name, password_hash FROM users WHERE email = $1 AND role = 'teacher'`,
      [email]
    );
    const row = result.rows[0];
    if (!row || !(await verifySecret(password, row.password_hash))) {
      await recordFailure(key, LOCKOUT);
      reply.code(401);
      return { error: 'Wrong details', message: 'That email or password is not right.' };
    }

    await clearFailures(key);
    const token = fastify.jwt.sign({ sub: row.id, role: 'teacher' }, { expiresIn: '24h' });
    return { token, user: { id: row.id, name: row.name, email, role: 'teacher' } };
  });

  // Student sign-in, step 1: class code -> names to tap
  fastify.get('/auth/class/:code/students', async (request, reply) => {
    const parsed = ClassCodeSchema.safeParse((request.params as { code: string }).code);
    if (!parsed.success) {
      reply.code(404);
      return { error: 'Not found', message: 'No class has that code.' };
    }

    const cls = await query<{ id: string; name: string }>(
      'SELECT id, name FROM classes WHERE join_code = $1',
      [parsed.data]
    );
    if (cls.rows.length === 0) {
      reply.code(404);
      return { error: 'Not found', message: 'No class has that code.' };
    }

    const students = await query<{ id: string; name: string }>(
      `SELECT s.id, u.name
       FROM class_enrollments ce
       JOIN students s ON s.id = ce.student_id
       JOIN users u ON u.id = s.user_id
       WHERE ce.class_id = $1
       ORDER BY u.name`,
      [cls.rows[0].id]
    );
    return { className: cls.rows[0].name, students: students.rows };
  });

  // Student sign-in, step 2: class code + name + PIN
  fastify.post('/auth/student/login', async (request, reply) => {
    const parsed = StudentLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request', message: 'Enter your 4-digit PIN.' };
    }
    const { classCode, studentId, pin } = parsed.data;

    const key = `student:${studentId}`;
    const wait = await secondsLocked(key);
    if (wait > 0) {
      reply.code(429);
      return {
        error: 'Too many tries',
        message: `Too many wrong tries. Ask your teacher, or try again in ${Math.ceil(wait / 60)} minutes.`,
      };
    }

    const result = await query<{
      student_id: string;
      user_id: string;
      name: string;
      password_hash: string;
      grade: number;
      language: string;
      accessibility_needs: string[];
      accessibility_profile: Record<string, unknown>;
    }>(
      `SELECT s.id AS student_id, s.user_id, u.name, u.password_hash,
              s.grade, s.language, s.accessibility_needs, s.accessibility_profile
       FROM class_enrollments ce
       JOIN classes c ON c.id = ce.class_id
       JOIN students s ON s.id = ce.student_id
       JOIN users u ON u.id = s.user_id
       WHERE c.join_code = $1 AND s.id = $2`,
      [classCode, studentId]
    );
    const row = result.rows[0];
    if (!row || !(await verifySecret(pin, row.password_hash))) {
      await recordFailure(key, LOCKOUT);
      reply.code(401);
      return { error: 'Wrong PIN', message: 'That PIN is not right.' };
    }

    await clearFailures(key);
    const token = fastify.jwt.sign(
      { sub: row.user_id, role: 'student', studentId: row.student_id },
      { expiresIn: '24h' }
    );
    return {
      token,
      user: { id: row.user_id, name: row.name, role: 'student' },
      student: {
        id: row.student_id,
        grade: row.grade,
        language: row.language,
        accessibilityNeeds: row.accessibility_needs,
        accessibilityProfile: row.accessibility_profile,
                settings: effectiveSettings(row.accessibility_needs, row.accessibility_profile),
      },
    };
  });
}