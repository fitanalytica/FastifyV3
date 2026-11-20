import type { FastifyRequest } from 'fastify';
import { watchToken } from '../../../services/auth/watchToken.js';
import type { DevLoginResponse, WatchTokenBody } from '../../../types/index.js';

/** POST /phone/v3/auth/watch-token. The phone gives the watch its own tokens; the watch's install row gets the user's id (docs/data/api.md section 1d). */
export const watchTokenV3 = (req: FastifyRequest): Promise<DevLoginResponse> => watchToken(req.server, req.userid!, req.auth!.downloadid, req.body as WatchTokenBody, req.ip);
