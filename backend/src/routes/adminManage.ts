import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query, transaction } from '../db/index.js';
import { hashSecret } from '../auth/passwords.js';
import { generateJoinCode, generatePin } from '../auth/codes.js';
import { generateAdminPassword } from '../auth/adminPassword.js';

/**
 * Admin-only management of the whole school: teachers, classes and students.
 * (Questions use the regular /questions routes, which already let admins edit everything.)
 * Must be registered behind requireSignedIn + requireRole('admin').
 */

const Id = z.object({ id: z.string().uuid() });
const Grade = z.number().int().min(9).max(10);
const Needs = z
  .array(z.enum(['blind', 'low_vision', 'dyslexia', 'adhd', 'motor_difficulty', 'none']))
  .min(1)
  .max(6);

const TeacherCreate = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email().max(255),
  })
  .strict();
const TeacherUpdate = TeacherCreate.partial().strict();

const ClassCreate = z
  .object({
    teacherId: z.string().uuid(),
    name: z.string().trim().min(1).max(255),
    grade: Grade,
    subject: z.string().trim().min(1).max(100),
  })
  .strict();
const ClassUpdate = ClassCreate.partial().strict();

const StudentCreate = z
  .object({
    name: z.string().trim().min(2).max(100),
    grade: Grade,
    language: z.enum(['en', 'hi', 'kn']),
    accessibilityNeeds: Needs.default(['none']),
    classIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict();
const StudentUpdate = StudentCreate.partial().strict();
const StudentBulk = z
  .object({
    names: z.array(z.string().trim().min(2).max(100)).min(1).max(200),
    grade: Grade,
    language: z.enum(['en', 'hi', 'kn']),
    classIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict();

function bad(reply: FastifyReply, message: string, code = 400) {
  reply.code(code);
  return { error: code === 404 ? 'Not found' : 'Invalid request', message };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'request'}: ${issue.message}` : 'Check the details.';
}

/** Classes must exist and match the student's grade. */
async function checkClasses(classIds: string[], grade: number): Promise<string | null> {
  if (classIds.length === 0) return null;
  const found = await query<{ id: string; grade: number }>(
    'SELECT id, grade FROM classes WHERE id = ANY($1::uuid[])',
    [classIds]
  );
  if (found.rows.length !== classIds.length) return 'One of those classes does not exist.';
  if (found.rows.some((c) => c.grade !== grade)) return 'A student can only join classes of their own grade.';
  return null;
}

export default async function adminManageRoutes(fastify: FastifyInstance) {
  // ---------- overview ----------
  fastify.get('/admin/overview', async () => {
    const r = await query<Record<string, string>>(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role = 'teacher') AS teachers,
        (SELECT COUNT(*) FROM students) AS students,
        (SELECT COUNT(*) FROM classes) AS classes,
        (SELECT COUNT(*) FROM questions) AS questions,
        (SELECT COUNT(*) FROM papers) AS papers`);
    const counts = Object.fromEntries(Object.entries(r.rows[0]).map(([k, v]) => [k, Number(v)]));
    // Small breakdowns for the overview charts
    const [byType, bySubject, byNeed, byGrade] = await Promise.all([
      query<{ key: string; n: number }>(`SELECT type AS key, COUNT(*)::int AS n FROM questions GROUP BY type`),
      query<{ key: string; n: number }>(
        `SELECT subject AS key, COUNT(*)::int AS n FROM questions GROUP BY subject ORDER BY n DESC LIMIT 6`
      ),
      query<{ key: string; n: number }>(
        `SELECT need AS key, COUNT(*)::int AS n FROM students, unnest(accessibility_needs) AS need
         WHERE need <> 'none' GROUP BY need`
      ),
      query<{ key: string; n: number }>(`SELECT grade::text AS key, COUNT(*)::int AS n FROM students GROUP BY grade`),
    ]);
    const toMap = (rows: { key: string; n: number }[]) => Object.fromEntries(rows.map((x) => [x.key, x.n]));
    return {
      ...counts,
      questionsByType: toMap(byType.rows),
      questionsBySubject: toMap(bySubject.rows),
      studentsByNeed: toMap(byNeed.rows),
      studentsByGrade: toMap(byGrade.rows),
    };
  });

  // ---------- teachers ----------
  fastify.get('/admin/teachers', async () => {
    const r = await query(`
      SELECT u.id, u.name, u.email, u.created_at,
             (SELECT COUNT(*)::int FROM classes c WHERE c.teacher_id = u.id) AS class_count,
             (SELECT COUNT(*)::int FROM questions q WHERE q.created_by = u.id) AS question_count
      FROM users u WHERE u.role = 'teacher' ORDER BY u.name`);
    return r.rows;
  });

  fastify.post('/admin/teachers', async (request, reply) => {
    const body = TeacherCreate.safeParse(request.body);
    if (!body.success) return bad(reply, firstIssue(body.error));
    const password = generateAdminPassword().slice(0, 12);
    try {
      const r = await query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'teacher') RETURNING id`,
        [body.data.email, await hashSecret(password), body.data.name]
      );
      request.log.info({ adminId: request.user.sub, teacherId: r.rows[0].id }, 'Admin added a teacher');
      reply.code(201);
      return { id: r.rows[0].id, ...body.data, password };
    } catch (error: any) {
      if (error.code === '23505') return bad(reply, 'There is already an account with that email.', 409);
      throw error;
    }
  });

  fastify.put('/admin/teachers/:id', async (request, reply) => {
    const params = Id.safeParse(request.params);
    const body = TeacherUpdate.safeParse(request.body);
    if (!params.success) return bad(reply, 'Teacher not found.', 404);
    if (!body.success) return bad(reply, firstIssue(body.error));
    try {
      const r = await query(
        `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), updated_at = NOW()
         WHERE id = $3 AND role = 'teacher' RETURNING id, name, email`,
        [body.data.name ?? null, body.data.email ?? null, params.data.id]
      );
      if (!r.rows[0]) return bad(reply, 'Teacher not found.', 404);
      return r.rows[0];
    } catch (error: any) {
      if (error.code === '23505') return bad(reply, 'There is already an account with that email.', 409);
      throw error;
    }
  });

  fastify.post('/admin/teachers/:id/reset-password', async (request, reply) => {
    const params = Id.safeParse(request.params);
    if (!params.success) return bad(reply, 'Teacher not found.', 404);
    const password = generateAdminPassword().slice(0, 12);
    const r = await query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 AND role = 'teacher' RETURNING id`,
      [await hashSecret(password), params.data.id]
    );
    if (!r.rows[0]) return bad(reply, 'Teacher not found.', 404);
    request.log.info({ adminId: request.user.sub, teacherId: params.data.id }, 'Admin reset a teacher password');
    return { password };
  });

  fastify.delete('/admin/teachers/:id', async (request, reply) => {
    const params = Id.safeParse(request.params);
    if (!params.success) return bad(reply, 'Teacher not found.', 404);
    const papers = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM papers WHERE teacher_id = $1', [params.data.id]);
    if (papers.rows[0].n > 0) {
      return bad(reply, `This teacher has ${papers.rows[0].n} exam papers. Move or delete those first.`, 409);
    }
    // Their questions stay in the bank; their classes go (students stay, unenrolled)
    await query('UPDATE questions SET created_by = NULL WHERE created_by = $1', [params.data.id]);
    const r = await query(`DELETE FROM users WHERE id = $1 AND role = 'teacher' RETURNING id`, [params.data.id]);
    if (!r.rows[0]) return bad(reply, 'Teacher not found.', 404);
    request.log.warn({ adminId: request.user.sub, teacherId: params.data.id }, 'Admin deleted a teacher');
    return { deleted: true };
  });

  // ---------- classes ----------
  fastify.get('/admin/classes', async () => {
    const r = await query(`
      SELECT c.id, c.name, c.grade, c.subject, c.join_code, c.teacher_id, u.name AS teacher_name,
             (SELECT COUNT(*)::int FROM class_enrollments ce WHERE ce.class_id = c.id) AS student_count
      FROM classes c JOIN users u ON u.id = c.teacher_id
      ORDER BY c.grade, c.name`);
    return r.rows;
  });

  fastify.post('/admin/classes', async (request, reply) => {
    const body = ClassCreate.safeParse(request.body);
    if (!body.success) return bad(reply, firstIssue(body.error));
    const teacher = await query(`SELECT 1 FROM users WHERE id = $1 AND role IN ('teacher', 'admin')`, [body.data.teacherId]);
    if (!teacher.rows[0]) return bad(reply, 'That teacher does not exist.');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await query<{ id: string; join_code: string }>(
          `INSERT INTO classes (teacher_id, name, grade, subject, join_code) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, join_code`,
          [body.data.teacherId, body.data.name, body.data.grade, body.data.subject, generateJoinCode()]
        );
        reply.code(201);
        return { id: r.rows[0].id, joinCode: r.rows[0].join_code };
      } catch (error: any) {
        if (error.code !== '23505') throw error;
      }
    }
    return bad(reply, 'Could not make a class code. Please try again.', 500);
  });

  fastify.put('/admin/classes/:id', async (request, reply) => {
    const params = Id.safeParse(request.params);
    const body = ClassUpdate.safeParse(request.body);
    if (!params.success) return bad(reply, 'Class not found.', 404);
    if (!body.success) return bad(reply, firstIssue(body.error));
    const d = body.data;
    if (d.grade !== undefined) {
      const mismatch = await query(
        `SELECT 1 FROM class_enrollments ce JOIN students s ON s.id = ce.student_id
         WHERE ce.class_id = $1 AND s.grade <> $2 LIMIT 1`,
        [params.data.id, d.grade]
      );
      if (mismatch.rows[0]) return bad(reply, 'Students of another grade are in this class. Remove them first.');
    }
    const r = await query(
      `UPDATE classes SET teacher_id = COALESCE($1, teacher_id), name = COALESCE($2, name),
              grade = COALESCE($3, grade), subject = COALESCE($4, subject), updated_at = NOW()
       WHERE id = $5 RETURNING id`,
      [d.teacherId ?? null, d.name ?? null, d.grade ?? null, d.subject ?? null, params.data.id]
    );
    if (!r.rows[0]) return bad(reply, 'Class not found.', 404);
    return { updated: true };
  });

  fastify.delete('/admin/classes/:id', async (request, reply) => {
    const params = Id.safeParse(request.params);
    if (!params.success) return bad(reply, 'Class not found.', 404);
    const r = await query('DELETE FROM classes WHERE id = $1 RETURNING id', [params.data.id]);
    if (!r.rows[0]) return bad(reply, 'Class not found.', 404);
    request.log.warn({ adminId: request.user.sub, classId: params.data.id }, 'Admin deleted a class');
    return { deleted: true };
  });

  // ---------- students ----------
  fastify.get('/admin/students', async () => {
    const r = await query(`
      SELECT s.id, u.name, s.grade, s.language, s.accessibility_needs, s.created_at,
             COALESCE(
               (SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'joinCode', c.join_code) ORDER BY c.name)
                FROM class_enrollments ce JOIN classes c ON c.id = ce.class_id
                WHERE ce.student_id = s.id), '[]'::json) AS classes
      FROM students s JOIN users u ON u.id = s.user_id
      ORDER BY s.grade, u.name`);
    return r.rows;
  });

  fastify.post('/admin/students', async (request, reply) => {
    const body = StudentCreate.safeParse(request.body);
    if (!body.success) return bad(reply, firstIssue(body.error));
    const { name, grade, language, accessibilityNeeds } = body.data;
    const classIds = [...new Set(body.data.classIds)];
    const problem = await checkClasses(classIds, grade);
    if (problem) return bad(reply, problem);

    const pin = generatePin();
    const pinHash = await hashSecret(pin);
    const id = await transaction(async (client) => {
      const email = `student-${randomUUID()}@students.samapatra.invalid`;
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'student') RETURNING id`,
        [email, pinHash, name]
      );
      const student = await client.query<{ id: string }>(
        `INSERT INTO students (user_id, grade, language, accessibility_needs) VALUES ($1, $2, $3, $4) RETURNING id`,
        [user.rows[0].id, grade, language, accessibilityNeeds]
      );
      for (const classId of classIds) {
        await client.query('INSERT INTO class_enrollments (class_id, student_id) VALUES ($1, $2)', [
          classId,
          student.rows[0].id,
        ]);
      }
      return student.rows[0].id;
    });
    reply.code(201);
    return { id, name, pin };
  });

  // Many students at once (one name per line in the panel). Every PIN is shown once.
  fastify.post('/admin/students/bulk', async (request, reply) => {
    const body = StudentBulk.safeParse(request.body);
    if (!body.success) return bad(reply, firstIssue(body.error));
    const { grade, language } = body.data;
    const classIds = [...new Set(body.data.classIds)];
    const problem = await checkClasses(classIds, grade);
    if (problem) return bad(reply, problem);

    const created = await transaction(async (client) => {
      const out: { id: string; name: string; pin: string }[] = [];
      for (const name of body.data.names) {
        const pin = generatePin();
        const user = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'student') RETURNING id`,
          [`student-${randomUUID()}@students.samapatra.invalid`, await hashSecret(pin), name]
        );
        const student = await client.query<{ id: string }>(
          `INSERT INTO students (user_id, grade, language, accessibility_needs) VALUES ($1, $2, $3, $4) RETURNING id`,
          [user.rows[0].id, grade, language, ['none']]
        );
        for (const classId of classIds) {
          await client.query('INSERT INTO class_enrollments (class_id, student_id) VALUES ($1, $2)', [
            classId,
            student.rows[0].id,
          ]);
        }
        out.push({ id: student.rows[0].id, name, pin });
      }
      return out;
    });
    request.log.info({ adminId: request.user.sub, count: created.length }, 'Admin added students in bulk');
    reply.code(201);
    return { students: created };
  });

  fastify.put('/admin/students/:id', async (request, reply) => {
    const params = Id.safeParse(request.params);
    const body = StudentUpdate.safeParse(request.body);
    if (!params.success) return bad(reply, 'Student not found.', 404);
    if (!body.success) return bad(reply, firstIssue(body.error));
    const current = await query<{ user_id: string; grade: number }>(
      'SELECT user_id, grade FROM students WHERE id = $1',
      [params.data.id]
    );
    if (!current.rows[0]) return bad(reply, 'Student not found.', 404);
    const d = body.data;
    const grade = d.grade ?? current.rows[0].grade;

    let classIds = d.classIds ? [...new Set(d.classIds)] : undefined;
    if (!classIds && d.grade !== undefined && d.grade !== current.rows[0].grade) {
      return bad(reply, 'Changing the grade also needs the new list of classes.');
    }
    if (classIds) {
      const problem = await checkClasses(classIds, grade);
      if (problem) return bad(reply, problem);
    }

    await transaction(async (client) => {
      if (d.name) {
        await client.query('UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2', [d.name, current.rows[0].user_id]);
      }
      await client.query(
        `UPDATE students SET grade = $1, language = COALESCE($2, language),
                accessibility_needs = COALESCE($3, accessibility_needs), updated_at = NOW()
         WHERE id = $4`,
        [grade, d.language ?? null, d.accessibilityNeeds ?? null, params.data.id]
      );
      if (classIds) {
        await client.query('DELETE FROM class_enrollments WHERE student_id = $1', [params.data.id]);
        for (const classId of classIds) {
          await client.query('INSERT INTO class_enrollments (class_id, student_id) VALUES ($1, $2)', [
            classId,
            params.data.id,
          ]);
        }
      }
    });
    return { updated: true };
  });

  fastify.post('/admin/students/:id/reset-pin', async (request, reply) => {
    const params = Id.safeParse(request.params);
    if (!params.success) return bad(reply, 'Student not found.', 404);
    const pin = generatePin();
    const r = await query(
      `UPDATE users SET password_hash = $1, updated_at = NOW()
       WHERE id = (SELECT user_id FROM students WHERE id = $2) RETURNING id`,
      [await hashSecret(pin), params.data.id]
    );
    if (!r.rows[0]) return bad(reply, 'Student not found.', 404);
    return { pin };
  });

  fastify.delete('/admin/students/:id', async (request, reply) => {
    const params = Id.safeParse(request.params);
    if (!params.success) return bad(reply, 'Student not found.', 404);
    const r = await query(
      `DELETE FROM users WHERE id = (SELECT user_id FROM students WHERE id = $1) AND role = 'student' RETURNING id`,
      [params.data.id]
    );
    if (!r.rows[0]) return bad(reply, 'Student not found.', 404);
    request.log.warn({ adminId: request.user.sub, studentId: params.data.id }, 'Admin deleted a student');
    return { deleted: true };
  });
}
