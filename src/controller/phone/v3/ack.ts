import type { FastifyRequest } from 'fastify';
import { ackActivities } from '../../../services/activities/inbox.js';
import type { AckBody, AckResponse } from '../../../types/index.js';

/** POST /phone/v3/activities/ack { ids }. The phone has stored these watch activities. */
export const ackV3 = (req: FastifyRequest): Promise<AckResponse> =>
  ackActivities(req.server, req.userid!, (req.body as AckBody).ids);
