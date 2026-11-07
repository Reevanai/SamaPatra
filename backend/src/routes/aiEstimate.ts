import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAIConfig } from '../services/ai/config.js';
import { estimateSeconds } from '../services/aiTiming.js';

const EstimateQuery = z.object({
  operation: z.enum(['pdf_import']),
  pages: z.coerce.number().int().min(1).max(500).optional(),
  bytes: z.coerce.number().int().min(1).max(100 * 1024 * 1024).optional(),
});

/** How long an AI job will probably take, so the apps can show a countdown. Teachers and admins. */
export default async function aiEstimateRoutes(fastify: FastifyInstance) {
  fastify.get('/ai/estimate', async (request, reply) => {
    const parsed = EstimateQuery.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request', message: 'Say which job (operation) and its size (pages or bytes).' };
    }
    const config = await getAIConfig();
    return estimateSeconds({ ...parsed.data, provider: config.pdfProvider });
  });
}
