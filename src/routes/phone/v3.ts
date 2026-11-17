import { FastifyInstance } from 'fastify';
import { activitiesBatchV3 } from '../../controller/common/v3/activitiesbatch.js';
import { deleteActivityV3 } from '../../controller/common/v3/deleteactivity.js';
import { meV3 } from '../../controller/common/v3/me.js';
import { refreshTokenV3 } from '../../controller/common/v3/refreshtoken.js';
import { ackV3 } from '../../controller/phone/v3/ack.js';
import { activitiesV3 } from '../../controller/phone/v3/activities.js';
import { feedActivityV3 } from '../../controller/phone/v3/feedactivity.js';
import { feedV3 } from '../../controller/phone/v3/feed.js';
import { devLoginV3 } from '../../controller/phone/v3/devlogin.js';
import { inboxV3 } from '../../controller/phone/v3/inbox.js';
import { mediaV3 } from '../../controller/phone/v3/media.js';
import { profileImageCommitV3 } from '../../controller/phone/v3/profileimagecommit.js';
import { profileBgV3, profilePicV3 } from '../../controller/phone/v3/profileimageget.js';
import { profileImagePresignV3 } from '../../controller/phone/v3/profileimagepresign.js';
import { profileImageResetV3 } from '../../controller/phone/v3/profileimagereset.js';
import { mediaCommitV3 } from '../../controller/phone/v3/mediacommit.js';
import { mediaPresignV3 } from '../../controller/phone/v3/mediapresign.js';
import { mediaRemoveV3 } from '../../controller/phone/v3/mediaremove.js';
import { postDeleteV3 } from '../../controller/phone/v3/postdelete.js';
import { postPutV3 } from '../../controller/phone/v3/postput.js';
import { postsV3 } from '../../controller/phone/v3/posts.js';
import { profilePutV3 } from '../../controller/phone/v3/profileput.js';
import { profileVisibilityV3 } from '../../controller/phone/v3/profilevisibility.js';
import { userFeedV3 } from '../../controller/phone/v3/userfeed.js';
import { userProfileV3 } from '../../controller/phone/v3/userprofile.js';
import { weatherV3 } from '../../controller/phone/v3/weather.js';
import { accountDeleteV3 } from '../../controller/phone/v3/accountdelete.js';
import { accountCodeV3, accountCodeVerifyV3 } from '../../controller/phone/v3/accountcode.js';
import { loginV3 } from '../../controller/phone/v3/login.js';
import { logoutV3 } from '../../controller/phone/v3/logout.js';
import { profileV3 } from '../../controller/phone/v3/profile.js';
import { profileLocationV3 } from '../../controller/phone/v3/profilelocation.js';
import { DeleteCodeBodySchema, LoginBodySchema, ProfileBodySchema, VisibilityBodySchema, UserFeedQuerySchema, UserIdParamsSchema, WeatherBodySchema, PostIdParamsSchema, PostsQuerySchema, PutPostBodySchema } from '../../schemas/index.js';
import { AckBodySchema, ActivityIdParamsSchema, BatchBodySchema, CommitBodySchema, DevLoginBodySchema, ProfileCommitBodySchema, ProfileImageParamsSchema, ProfileKindParamsSchema, ProfilePresignBodySchema, FeedQuerySchema, InboxQuerySchema, LocationBodySchema, MediaParamsSchema, LogoutBodySchema, PresignBodySchema, RefreshBodySchema, RestoreQuerySchema } from '../../schemas/index.js';

async function phoneRouterV3(fastify: FastifyInstance) {
  const isAuth = { onRequest: [fastify.authenticate('phone')] };
  const isAuthBigBody = { ...isAuth, bodyLimit: 8 * 1024 * 1024 };

  // UNSECURED ROUTES

  fastify.post('/auth/refresh', { schema: { body: RefreshBodySchema } }, refreshTokenV3);
  fastify.post('/auth/login', { schema: { body: LoginBodySchema } }, loginV3);
  fastify.post('/auth/dev-login', { schema: { body: DevLoginBodySchema } }, devLoginV3); // local testing only: 404 unless DEV_LOGIN=true

  // SECURED ROUTES

  fastify.get('/me', isAuth, meV3);
  fastify.get('/profile', isAuth, profileV3);
  fastify.put('/profile', { ...isAuth, schema: { body: ProfileBodySchema } }, profilePutV3);
  fastify.put('/profile/location', { ...isAuth, schema: { body: LocationBodySchema } }, profileLocationV3);
  fastify.put('/profile/visibility', { ...isAuth, schema: { body: VisibilityBodySchema } }, profileVisibilityV3);
  fastify.post('/account/delete-code', isAuth, accountCodeV3);
  fastify.post('/account/delete-code/verify', { ...isAuth, schema: { body: DeleteCodeBodySchema } }, accountCodeVerifyV3);
  fastify.delete('/account', { ...isAuth, schema: { body: DeleteCodeBodySchema } }, accountDeleteV3);
  fastify.post('/auth/logout', { ...isAuth, schema: { body: LogoutBodySchema } }, logoutV3);

  fastify.post('/activities/batch', { ...isAuthBigBody, schema: { body: BatchBodySchema } }, activitiesBatchV3);
  fastify.get('/activities', { ...isAuth, schema: { querystring: RestoreQuerySchema } }, activitiesV3);
  fastify.get('/feed', { ...isAuth, schema: { querystring: FeedQuerySchema } }, feedV3);
  fastify.get('/feed/:activityid', { ...isAuth, schema: { params: ActivityIdParamsSchema } }, feedActivityV3);
  fastify.get('/users/:userid', { ...isAuth, schema: { params: UserIdParamsSchema } }, userProfileV3);
  fastify.get('/users/:userid/feed', { ...isAuth, schema: { params: UserIdParamsSchema, querystring: UserFeedQuerySchema } }, userFeedV3);
  fastify.post('/weather', { ...isAuth, schema: { body: WeatherBodySchema } }, weatherV3);
  fastify.get('/posts', { ...isAuth, schema: { querystring: PostsQuerySchema } }, postsV3);
  fastify.put('/posts/:postid', { ...isAuth, schema: { params: PostIdParamsSchema, body: PutPostBodySchema } }, postPutV3);
  fastify.delete('/posts/:postid', { ...isAuth, schema: { params: PostIdParamsSchema } }, postDeleteV3);
  // The media routes take the id of an activity or of a post (ids are random UUIDs, so they never clash).
  fastify.get('/media/:activityid/:value', { onRequest: [fastify.authenticate('phone', { altHeader: 'x-access-token' })], schema: { params: MediaParamsSchema } }, mediaV3);
  fastify.delete('/media/:activityid/:value', { ...isAuth, schema: { params: MediaParamsSchema } }, mediaRemoveV3);
  fastify.post('/media/:activityid/presign', { ...isAuth, schema: { params: ActivityIdParamsSchema, body: PresignBodySchema } }, mediaPresignV3);
  fastify.post('/media/:activityid/commit', { ...isAuth, schema: { params: ActivityIdParamsSchema, body: CommitBodySchema } }, mediaCommitV3);
  fastify.post('/profile/image/presign', { ...isAuth, schema: { body: ProfilePresignBodySchema } }, profileImagePresignV3);
  fastify.post('/profile/image/commit', { ...isAuth, schema: { body: ProfileCommitBodySchema } }, profileImageCommitV3);
  fastify.delete('/profile/image/:kind', { ...isAuth, schema: { params: ProfileKindParamsSchema } }, profileImageResetV3);
  // The token may also come as X-Access-Token, as for the activity media (the loader follows the redirect to S3 itself).
  const image = { onRequest: [fastify.authenticate('phone', { altHeader: 'x-access-token' })], schema: { params: ProfileImageParamsSchema } };
  fastify.get('/profilepic/:userid/:value', image, profilePicV3);
  fastify.get('/profilebg/:userid/:value', image, profileBgV3);
  fastify.get('/activities/inbox', { ...isAuth, schema: { querystring: InboxQuerySchema } }, inboxV3);
  fastify.post('/activities/ack', { ...isAuth, schema: { body: AckBodySchema } }, ackV3);
  fastify.delete('/activities/:activityid', { ...isAuth, schema: { params: ActivityIdParamsSchema } }, deleteActivityV3);
}

export default phoneRouterV3;
