import { FastifyInstance } from 'fastify';
import { health } from '../controller/health.js';
import phoneRouter from './phone/index.js';
import storeRouter from './store/index.js';
import wearableRouter from './wearable/index.js';

async function routes(fastify: FastifyInstance) {
  fastify.get('/health', health);

  fastify.register(phoneRouter);
  fastify.register(wearableRouter);
  fastify.register(storeRouter);
}

export default routes;
