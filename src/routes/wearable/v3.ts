import { FastifyInstance } from 'fastify';
import { activitiesBatchV3 } from '../../controller/common/v3/activitiesbatch.js';
import { deleteActivityV3 } from '../../controller/common/v3/deleteactivity.js';
import { meV3 } from '../../controller/common/v3/me.js';
import { refreshTokenV3 } from '../../controller/common/v3/refreshtoken.js';
import { activitiesV3 } from '../../controller/wearable/v3/activities.js';
import { ActivityIdParamsSchema, BatchBodySchema, RefreshBodySchema, WearableRestoreQuerySchema } from '../../schemas/index.js';

// Only what the watch calls (docs/data/watch.md): no logout, no dev-login, no watch-token, no inbox (the inbox is the phone's).
async function wearableRouterV3(fastify: FastifyInstance) {
  const isAuth = { onRequest: [fastify.authenticate('watch')] };
  const isAuthBigBody = { ...isAuth, bodyLimit: 8 * 1024 * 1024 };

  // UNSECURED ROUTES

  fastify.post('/auth/refresh', { schema: { body: RefreshBodySchema } }, refreshTokenV3);

  // SECURED ROUTES

  fastify.get('/me', isAuth, meV3);

  fastify.post('/activities/batch', { ...isAuthBigBody, schema: { body: BatchBodySchema } }, activitiesBatchV3);
  fastify.get('/activities', { ...isAuth, schema: { querystring: WearableRestoreQuerySchema } }, activitiesV3);
  fastify.delete('/activities/:activityid', { ...isAuth, schema: { params: ActivityIdParamsSchema } }, deleteActivityV3);
}

export default wearableRouterV3;
