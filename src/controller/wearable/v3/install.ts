import type { FastifyRequest } from 'fastify';
import { install, type InstallReply } from '../../../services/auth/install.js';
import type { InstallBody } from '../../../types/index.js';

/** POST /wearable/v3/download. The watch's first call, before it has any token: its own install row, like the phone's (docs/data/api.md section 1d). */
export const installWearableV3 = (req: FastifyRequest): Promise<InstallReply> => install(req.server, req.body as InstallBody, req.ip, true);
