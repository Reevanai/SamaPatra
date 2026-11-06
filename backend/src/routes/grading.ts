import type { FastifyInstance } from 'fastify';
import { gradingService } from '../services/grading.js';
import { z } from 'zod';

const TeacherGradeSchema = z.object({
  marksAwarded: z.number().min(0),
  teacherFeedback: z.string().optional(),
});

export default async function gradingRoutes(fastify: FastifyInstance) {
  // Auto-grade a paper
  fastify.post('/grading/papers/:paperId/auto-grade', async (request, reply) => {
    const { paperId } = request.params as { paperId: string };

    try {
      const result = await gradingService.gradePaper(paperId);
      return { success: true, result };
    } catch (error: any) {
      fastify.log.error('Auto-grading error:', error);
      reply.code(500);
      return { error: 'Failed to grade paper', message: error.message };
    }
  });

  // Get grading summary for teacher review
  fastify.get('/grading/papers/:paperId/summary', async (request, reply) => {
    const { paperId } = request.params as { paperId: string };

    try {
      const summary = await gradingService.getGradingSummary(paperId);
      return { summary };
    } catch (error: any) {
      fastify.log.error('Grading summary error:', error);
      reply.code(500);
      return { error: 'Failed to get grading summary', message: error.message };
    }
  });

  // Grade single answer (AI-assisted)
  fastify.post('/grading/answers/:answerId/ai-grade', async (request, reply) => {
    const { answerId } = request.params as { answerId: string };

    try {
      const result = await gradingService.gradeAnswer(answerId);
      return { success: true, result };
    } catch (error: any) {
      fastify.log.error('AI grading error:', error);
      reply.code(500);
      return { error: 'Failed to grade answer', message: error.message };
    }
  });

  // Teacher approves/adjusts marks
  fastify.post('/grading/answers/:answerId/teacher-grade', async (request, reply) => {
    const { answerId } = request.params as { answerId: string };
    const validation = TeacherGradeSchema.safeParse(request.body);

    if (!validation.success) {
      reply.code(400);
      return { error: 'Invalid request', details: validation.error };
    }

    const { marksAwarded, teacherFeedback } = validation.data;

    try {
      await gradingService.teacherGrade(answerId, marksAwarded, teacherFeedback);
      return { success: true };
    } catch (error: any) {
      fastify.log.error('Teacher grading error:', error);
      reply.code(500);
      return { error: 'Failed to save grade', message: error.message };
    }
  });

  // Bulk approve AI suggestions
  fastify.post('/grading/papers/:paperId/approve-ai-grades', async (request, reply) => {
    const { paperId } = request.params as { paperId: string };
    const { answerIds } = request.body as { answerIds: string[] };

    if (!Array.isArray(answerIds)) {
      reply.code(400);
      return { error: 'answerIds must be an array' };
    }

    const approved = [];
    const failed = [];

    for (const answerId of answerIds) {
      try {
        // Get AI suggested marks
        const result = await gradingService.gradeAnswer(answerId);
        // Approve it
        await gradingService.teacherGrade(
          answerId,
          result.aiSuggestedMarks,
          'AI suggestion approved by teacher'
        );
        approved.push(answerId);
      } catch (error) {
        fastify.log.error({ err: error, answerId }, "Failed to approve grade");
        failed.push(answerId);
      }
    }

    return {
      success: true,
      approved: approved.length,
      failed: failed.length,
      failedIds: failed,
    };
  });
}
