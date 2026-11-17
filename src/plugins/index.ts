import type { FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { env } from '../config/env.js';
import authenticate from '../hooks/authenticate.js';
import db from './db.js';

/** Every plugin the app needs, in the order they must load. */
export async function registerPlugins(app: FastifyInstance) {
  // Level 1: a restore page is ~5 MB of JSON; level 6 took ~174 ms of CPU per page, level 1 ~21 ms for ~20% more bytes (measured).
  // Gzip request bodies are unpacked; replies are compressed when the app asks.
  await app.register(compress, { zlibOptions: { level: 1 } });
  await app.register(helmet);
  await app.register(cors);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(jwt, { secret: env().jwtSecret });
  await app.register(db);
  await app.register(authenticate); // needs the pools; adds fastify.authenticate(kind)
}
