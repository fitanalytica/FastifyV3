import type { FastifyReply, FastifyRequest } from 'fastify';
import { deleteAccount } from '../../../services/account/deleteAccount.js';
import type { DeleteCodeBody } from '../../../types/index.js';

/** DELETE /phone/v3/account { code }. Deletes the account and everything of it, files included (docs/data/api.md section 8b). 204. */
export const accountDeleteV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  await deleteAccount(req.server, req.userid!, (req.body as DeleteCodeBody).code);
  return reply.code(204).send();
};
