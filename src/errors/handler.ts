import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './AppError.js';
import { ErrorCode, NOT_LOGGED } from './codes.js';

// Same body shape as v2: { statusCode, error, message, code, errorId }.
// Routine answers the app handles by itself are not logged (NOT_LOGGED, docs/data/schema.pg.md `apperrors`).
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const SECRET_KEYS = new Set(['refreshToken', 'accessToken', 'refresh_token', 'access_token', 'password']);

function redact(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null; // arrays are batches of user data: not logged
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, SECRET_KEYS.has(k) ? '[redacted]' : v]));
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export async function errorHandler(err: FastifyError | AppError, req: FastifyRequest, reply: FastifyReply) {
  const app = err instanceof AppError;
  const statusCode = app ? err.statusCode : ((err as FastifyError).statusCode ?? 500);
  const server = statusCode >= 500;
  const error = app ? err.error : server ? 'Internal Server Error' : 'Bad Request';
  const message = server ? 'Internal Server Error' : err.message;
  const invalid = !app && Boolean((err as FastifyError).validation); // Fastify's schema check failed
  const code: ErrorCode = (app ? err.code : undefined) ?? (invalid ? ErrorCode.BAD_REQUEST : ErrorCode.UNHANDLED);

  let errorId = '';
  if (!NOT_LOGGED.has(code)) {
    try {
      const r = await req.server.pg.writer.query(
        `INSERT INTO apperrors (status_code, method, url, ip, error, message, code, stack, body, userid, value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING errorid`,
        [statusCode, METHODS.has(req.method) ? req.method : null, req.url, req.ip, error, err.message, code,
         err.stack ?? null, json(redact(req.body)), (req as any).userid ?? null, json(app ? err.value : null)],
      );
      errorId = r.rows[0]?.errorid ?? '';
    } catch (e) {
      req.log.error(e, 'could not write apperrors'); // never let logging break the reply
    }
  }
  if (server) req.log.error(err);
  return reply.status(statusCode).send({ statusCode, error, message, code, errorId });
}

export function notFoundHandler(_req: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({ statusCode: 404, error: 'Not Found', message: 'Route not found', code: ErrorCode.NOT_FOUND, errorId: '' });
}
