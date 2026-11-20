import { FastifyInstance } from 'fastify';
import { activitiesBatchV3 } from '../../controller/common/v3/activitiesbatch.js';
import { deleteActivityV3 } from '../../controller/common/v3/deleteactivity.js';
import { refreshTokenV3 } from '../../controller/common/v3/refreshtoken.js';
import { activitiesV3 } from '../../controller/wearable/v3/activities.js';
import { installWearableV3 } from '../../controller/wearable/v3/install.js';
import { ActivityIdParamsSchema, BatchBodySchema, InstallBodySchema, RefreshBodySchema, WearableRestoreQuerySchema } from '../../schemas/index.js';

// Only what the watch calls (docs/data/watch.md): no logout, no dev-login, no watch-token (the phone's), no inbox (the inbox is the phone's). `/download` is the watch's first call, before it has a token.
async function wearableRouterV3(fastify: FastifyInstance) {
  const isAuth = { onRequest: [fastify.authenticate('watch')] };
  const isAuthBigBody = { ...isAuth, bodyLimit: 8 * 1024 * 1024 };

  // UNSECURED ROUTES

  fastify.post('/download', { schema: { body: InstallBodySchema } }, installWearableV3);
  fastify.post('/auth/refresh', { schema: { body: RefreshBodySchema } }, refreshTokenV3);

  // SECURED ROUTES


  fastify.post('/activities/batch', { ...isAuthBigBody, schema: { body: BatchBodySchema } }, activitiesBatchV3);
  fastify.get('/activities', { ...isAuth, schema: { querystring: WearableRestoreQuerySchema } }, activitiesV3);
  fastify.delete('/activities/:activityid', { ...isAuth, schema: { params: ActivityIdParamsSchema } }, deleteActivityV3);
}

export default wearableRouterV3;
