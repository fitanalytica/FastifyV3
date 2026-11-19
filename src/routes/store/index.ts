import { FastifyInstance } from 'fastify';
import { appStoreNotificationV3 } from '../../controller/store/v3/appstorenotification.js';
import { AppStoreNotificationBodySchema } from '../../schemas/index.js';

// The App Store and Play Store notifications (v2: appstore/ and playstore/ under the "store" subdomain). Not signed in: the store's own signature is the proof, checked in the service.
async function storeRouterV3(fastify: FastifyInstance) {
  fastify.post('/appstore', { schema: { body: AppStoreNotificationBodySchema } }, appStoreNotificationV3);
}

async function storeRouter(fastify: FastifyInstance) {
  fastify.register(storeRouterV3, { prefix: 'store/v3' });
}

export default storeRouter;
