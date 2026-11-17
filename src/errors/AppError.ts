import type { ErrorCode } from './codes.js';

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public error: string,
    public code?: ErrorCode,
    public value?: unknown,
  ) {
    super(message);
  }
}

const mk = (statusCode: number, error: string) =>
  (message?: string, code?: ErrorCode, value?: unknown) =>
    new AppError(message ?? error, statusCode, error, code, value);

export const errors = {
  BadRequest: mk(400, 'Bad Request'),
  Unauthorized: mk(401, 'Unauthorized'),
  Forbidden: mk(403, 'Forbidden'),
  NotFound: mk(404, 'Not Found'),
  Conflict: mk(409, 'Conflict'),
  UnprocessableEntity: mk(422, 'Unprocessable Entity'),
  TooManyRequests: mk(429, 'Too Many Requests'),
  Internal: mk(500, 'Internal Server Error'),
};
