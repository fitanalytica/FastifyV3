import type { FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import bodyEncoding from '../hooks/bodyEncoding.js';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { env } from '../config/env.js';
import authenticate from '../hooks/authenticate.js';
import db from './db.js';

/** Requests a minute for the picture routes (`GET /media/...`, `/profilepic/...`, `/profilebg/...`), per token. */
export const IMAGE_RATE_LIMIT = 600;
/** Redeeming a code: tries a minute per token, so codes cannot be guessed. */
export const REDEEM_RATE_LIMIT = 10;
const IMAGE_ROUTE = /\/(media\/:activityid\/:value|profilepic\/:userid\/:value|profilebg\/:userid\/:value)$/;

/** Every plugin the app needs, in the order they must load. */
export async function registerPlugins(app: FastifyInstance) {
  // Level 1: a restore page is ~5 MB of JSON; level 6 took ~174 ms of CPU per page, level 1 ~21 ms for ~20% more bytes (measured).
  // Gzip request bodies are unpacked; replies are compressed when the app asks.
  await app.register(compress, { zlibOptions: { level: 1 } });
  // A large body as gzip written in base64 text (the phone's way: see bodyEncoding.ts).
  await app.register(bodyEncoding);
  await app.register(helmet);
  await app.register(cors);
  // The pictures: a feed page makes dozens of image requests (each a redirect to S3), so these routes have a limit of their own, much higher, counted per
  // signed-in user (by token) instead of per address: people sharing a network do not share it. Everything else keeps the general limit.
  // Added BEFORE the rate limiter registers: it reads each route's `config.rateLimit` as the route is added, so the hook must have set it by then.
  // (A GET route is also registered as HEAD, so `method` can be a list.)
  app.addHook('onRoute', (route) => {
    // Signing in, and the install's first call, are open to anyone, so it is limited more than the rest (per address): LOGIN_RATE_LIMIT a minute, 20 by default. Read at each request.
    if ([route.method].flat().includes('POST') && /\/(auth\/login|download)$/.test(route.url)) {
      route.config = { ...route.config, rateLimit: { max: () => env().loginRateLimit, timeWindow: '1 minute' } };
    }
    if ([route.method].flat().includes('POST') && /\/redeem$/.test(route.url)) {
      route.config = { ...route.config, rateLimit: { max: REDEEM_RATE_LIMIT, timeWindow: '1 minute', keyGenerator: (req: { headers: Record<string, unknown>; ip: string }) => String(req.headers.authorization ?? req.ip) } };
    }
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
