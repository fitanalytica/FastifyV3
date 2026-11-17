import { FastifyInstance } from 'fastify';
import wearableRouterV3 from './v3.js';

async function wearableRouter(fastify: FastifyInstance) {
  fastify.register(wearableRouterV3, { prefix: 'wearable/v3' });
}

export default wearableRouter;
