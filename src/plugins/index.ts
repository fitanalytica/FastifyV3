import type { FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { env } from '../config/env.js';
import authenticate from '../hooks/authenticate.js';
import db from './db.js';

/** Requests a minute for the picture routes (`GET /media/...`, `/profilepic/...`, `/profilebg/...`), per token. */
export const IMAGE_RATE_LIMIT = 600;
const IMAGE_ROUTE = /\/(media\/:activityid\/:value|profilepic\/:userid\/:value|profilebg\/:userid\/:value)$/;

/** Every plugin the app needs, in the order they must load. */
export async function registerPlugins(app: FastifyInstance) {
  // Level 1: a restore page is ~5 MB of JSON; level 6 took ~174 ms of CPU per page, level 1 ~21 ms for ~20% more bytes (measured).
  // Gzip request bodies are unpacked; replies are compressed when the app asks.
  await app.register(compress, { zlibOptions: { level: 1 } });
  await app.register(helmet);
  await app.register(cors);
  // The pictures: a feed page makes dozens of image requests (each a redirect to S3), so these routes have a limit of their own, much higher, counted per
  // signed-in user (by token) instead of per address: people sharing a network do not share it. Everything else keeps the general limit.
  // Added BEFORE the rate limiter registers: it reads each route's `config.rateLimit` as the route is added, so the hook must have set it by then.
  // (A GET route is also registered as HEAD, so `method` can be a list.)
  app.addHook('onRoute', (route) => {
    if ([route.method].flat().includes('GET') && IMAGE_ROUTE.test(route.url)) {
      route.config = {
        ...route.config,
        rateLimit: { max: IMAGE_RATE_LIMIT, timeWindow: '1 minute', keyGenerator: (req: { headers: Record<string, unknown>; ip: string }) => String(req.headers['x-access-token'] ?? req.headers.authorization ?? req.ip) },
      };
    }
  });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(jwt, { secret: env().jwtSecret });
  await app.register(db);
  await app.register(authenticate); // needs the pools; adds fastify.authenticate(kind)
}
