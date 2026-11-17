import type { FastifyReply, FastifyRequest } from 'fastify';
import { putPost } from '../../../services/posts/putPost.js';
import type { PostIdParams, PutPostBody } from '../../../types/index.js';

/** PUT /phone/v3/posts/:postid. Makes the post or changes what it says: `{ status, media_v2 }`. */
export const postPutV3 = async (req: FastifyRequest, reply: FastifyReply) =>
  reply.send(await putPost(req.server, req.userid!, (req.params as PostIdParams).postid, req.body as PutPostBody));
