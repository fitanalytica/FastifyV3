import type { FastifyReply, FastifyRequest } from 'fastify';
import { purchaseIos } from '../../../services/store/purchaseIos.js';
import type { PurchaseIosBody } from '../../../types/index.js';

/** POST /phone/v3/purchases/ios. A purchase made on the phone: checked with the App Store, recorded and granted. Answers the purchase and the user's new state, as JSON text. */
export const purchaseIosV3 = async (req: FastifyRequest, reply: FastifyReply) =>
  reply.type('application/json').send(await purchaseIos(req.server, req.userid!, (req.body as PurchaseIosBody).signedTransaction));
