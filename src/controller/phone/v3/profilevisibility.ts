import type { FastifyRequest } from 'fastify';
import { setVisibility } from '../../../services/profile/setVisibility.js';
import type { VisibilityBody } from '../../../types/index.js';

/** PUT /phone/v3/profile/visibility { hidden }. Answers `{ hidden }` as saved. */
export const profileVisibilityV3 = (req: FastifyRequest) => setVisibility(req.server, req.userid!, (req.body as VisibilityBody).hidden);
