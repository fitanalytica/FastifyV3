import type { FastifyReply, FastifyRequest } from 'fastify';
import { redeem } from '../../../services/store/redeem.js';
import type { RedeemBody } from '../../../types/index.js';

/** POST /phone/v3/redeem. An invite code: claimed once, for the user. Answers what was redeemed and the user's new state, as JSON text. */
export const redeemV3 = async (req: FastifyRequest, reply: FastifyReply) =>
  reply.type('application/json').send(await redeem(req.server, req.userid!, (req.body as RedeemBody).code));
