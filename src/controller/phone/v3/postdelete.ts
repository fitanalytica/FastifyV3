import type { FastifyReply, FastifyRequest } from 'fastify';
import { deletePost } from '../../../services/posts/deletePost.js';
import type { PostIdParams } from '../../../types/index.js';

/** DELETE /phone/v3/posts/:postid. 204 when it is deleted, 404 for an unknown id (the app treats 404 as success). */
export const postDeleteV3 = async (req: FastifyRequest, reply: FastifyReply) => {
  await deletePost(req.server, req.userid!, (req.params as PostIdParams).postid);
  return reply.code(204).send();
};
