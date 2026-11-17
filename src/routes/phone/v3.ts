import { FastifyInstance } from 'fastify';
import { activitiesBatchV3 } from '../../controller/common/v3/activitiesbatch.js';
import { deleteActivityV3 } from '../../controller/common/v3/deleteactivity.js';
import { meV3 } from '../../controller/common/v3/me.js';
import { refreshTokenV3 } from '../../controller/common/v3/refreshtoken.js';
import { ackV3 } from '../../controller/phone/v3/ack.js';
import { activitiesV3 } from '../../controller/phone/v3/activities.js';
import { devLoginV3 } from '../../controller/phone/v3/devlogin.js';
import { inboxV3 } from '../../controller/phone/v3/inbox.js';
import { logoutV3 } from '../../controller/phone/v3/logout.js';
import { profileV3 } from '../../controller/phone/v3/profile.js';
import { profileLocationV3 } from '../../controller/phone/v3/profilelocation.js';
import { AckBodySchema, ActivityIdParamsSchema, BatchBodySchema, DevLoginBodySchema, InboxQuerySchema, LocationBodySchema, LogoutBodySchema, RefreshBodySchema, RestoreQuerySchema } from '../../schemas/index.js';

async function phoneRouterV3(fastify: FastifyInstance) {
  const isAuth = { onRequest: [fastify.authenticate('phone')] };
  const isAuthBigBody = { ...isAuth, bodyLimit: 8 * 1024 * 1024 };

  // UNSECURED ROUTES

  fastify.post('/auth/refresh', { schema: { body: RefreshBodySchema } }, refreshTokenV3);
  fastify.post('/auth/dev-login', { schema: { body: DevLoginBodySchema } }, devLoginV3); // local testing only: 404 unless DEV_LOGIN=true

  // SECURED ROUTES

  fastify.get('/me', isAuth, meV3);
  fastify.get('/profile', isAuth, profileV3);
  fastify.put('/profile/location', { ...isAuth, schema: { body: LocationBodySchema } }, profileLocationV3);
  fastify.post('/auth/logout', { ...isAuth, schema: { body: LogoutBodySchema } }, logoutV3);

  fastify.post('/activities/batch', { ...isAuthBigBody, schema: { body: BatchBodySchema } }, activitiesBatchV3);
  fastify.get('/activities', { ...isAuth, schema: { querystring: RestoreQuerySchema } }, activitiesV3);
  fastify.get('/activities/inbox', { ...isAuth, schema: { querystring: InboxQuerySchema } }, inboxV3);
  fastify.post('/activities/ack', { ...isAuth, schema: { body: AckBodySchema } }, ackV3);
  fastify.delete('/activities/:activityid', { ...isAuth, schema: { params: ActivityIdParamsSchema } }, deleteActivityV3);
}

export default phoneRouterV3;
