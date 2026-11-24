import type { FastifyReply, FastifyRequest } from 'fastify';
import { purchaseAndroid } from '../../../services/store/purchaseAndroid.js';
import type { PurchaseAndroidBody } from '../../../types/index.js';

/** POST /phone/v3/purchases/android. A Google Play purchase made on the phone: checked with Google Play, recorded and granted. Answers the purchase and the user's new state, as JSON text. */
export const purchaseAndroidV3 = async (req: FastifyRequest, reply: FastifyReply) =>
  reply.type('application/json').send(await purchaseAndroid(req.server, req.userid!, req.body as PurchaseAndroidBody));
