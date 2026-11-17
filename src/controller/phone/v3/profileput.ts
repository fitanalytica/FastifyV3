import type { FastifyRequest } from 'fastify';
import { putProfile } from '../../../services/profile/putProfile.js';
import type { ProfileBody } from '../../../types/index.js';

/** PUT /phone/v3/profile { fname?, lname?, about?, gender?, dobglobal?, height?, weight? }. Answers the fields as saved. */
export const profilePutV3 = (req: FastifyRequest) => putProfile(req.server, req.userid!, req.body as ProfileBody);
