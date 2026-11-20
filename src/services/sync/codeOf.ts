import type { FastifyInstance } from 'fastify';
import { AppError } from '../../errors/AppError.js';

/** The code a section reports for a failure: the `code` of an application error (a refused body), else `UNHANDLED` (logged: it is ours to fix). */
export function codeOf(app: FastifyInstance, error: unknown): string {
  if (error instanceof AppError && error.statusCode < 500) return error.code ?? 'BAD_REQUEST';
  app.log.error({ err: error }, 'sync section failed');
  return 'UNHANDLED';
}
