import type { FastifyRequest, FastifyReply } from 'fastify';
import { checkDeletionCode, sendDeletionCode } from '../../../services/account/deletionCode.js';
import type { DeleteCodeBody } from '../../../types/index.js';

/** POST /phone/v3/account/delete-code. E-mails a 6-digit code to the account's address (docs/data/api.md section 8b). */
export const accountCodeV3 = (req: FastifyRequest) => sendDeletionCode(req.server, req.userid!);

/** POST /phone/v3/account/delete-code/verify { code }. 204 when the code is right (it stays valid for the deletion); 400 `DELETE_CODE_WRONG` otherwise. */
export const accountCodeVerifyV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  await checkDeletionCode(req.server, req.userid!, (req.body as DeleteCodeBody).code);
  return reply.code(204).send();
};
