import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { LRUCache } from 'lru-cache';
import { env } from '../../config/env.js';
import type { AuthInfo } from '../../types/index.js';

/** SHA-256 of a token value: what usertokens stores. */
export const sha = (v: string): string => createHash('sha256').update(v).digest('hex');
/** A new random token value: 64 hex characters, which fits char(64). */
export const rand = (): string => randomBytes(32).toString('hex');
export const now = (): number => Math.floor(Date.now() / 1000);

/** The access JWT. Its payload carries the random access value; the server keeps only its hash. */
export function signAccess(app: FastifyInstance, access: string): string {
  return app.jwt.sign({ access_token: access }, { expiresIn: env().jwtExpiry });
}

// Positive entries live 5 minutes (a revoke takes effect within that). Misses are remembered
// for 30 s so a flood of bad tokens does not hit the database.
export const knownTokens = new LRUCache<string, AuthInfo>({ max: 10_000, ttl: 5 * 60_000 });
export const unknownTokens = new LRUCache<string, true>({ max: 10_000, ttl: 30_000 });

export function clearAuthCache(): void {
  knownTokens.clear();
  unknownTokens.clear();
}
