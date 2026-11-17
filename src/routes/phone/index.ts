import { FastifyInstance } from 'fastify';
import phoneRouterV3 from './v3.js';

async function phoneRouter(fastify: FastifyInstance) {
  fastify.register(phoneRouterV3, { prefix: 'phone/v3' });
}

export default phoneRouter;
