import { FastifyInstance } from 'fastify';

// The App Store and Play Store routes (v2: appstore/ and playstore/ under the "store" subdomain).
// Nothing is specified for v3 yet, so there are no routes here.
async function storeRouter(_fastify: FastifyInstance) {}

export default storeRouter;
