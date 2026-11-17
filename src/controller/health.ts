import type { FastifyRequest } from 'fastify';
import { databaseIsUp } from '../services/health.js';

/** GET /health */
export async function health(req: FastifyRequest): Promise<{ ok: boolean }> {
  return { ok: await databaseIsUp(req.server) };
}
