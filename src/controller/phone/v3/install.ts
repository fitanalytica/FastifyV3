import type { FastifyRequest } from 'fastify';
import { install, type InstallReply } from '../../../services/auth/install.js';
import type { InstallBody } from '../../../types/index.js';

/** POST /phone/v3/download. The phone's first call, signed in or not: its install row, and the place of its IP address as the first payload (docs/data/api.md section 1d). */
export const installV3 = (req: FastifyRequest): Promise<InstallReply> => install(req.server, req.body as InstallBody, req.ip, false);
