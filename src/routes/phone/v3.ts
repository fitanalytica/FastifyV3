import { FastifyInstance } from 'fastify';
import { refreshTokenV3 } from '../../controller/common/v3/refreshtoken.js';
import { feedActivityV3 } from '../../controller/phone/v3/feedactivity.js';
import { feedV3 } from '../../controller/phone/v3/feed.js';
import { devLoginV3 } from '../../controller/phone/v3/devlogin.js';
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
import { userFeedV3 } from '../../controller/phone/v3/userfeed.js';
import { userProfileV3 } from '../../controller/phone/v3/userprofile.js';
import { redeemV3 } from '../../controller/phone/v3/redeem.js';
import { purchaseIosV3 } from '../../controller/phone/v3/purchaseios.js';
import { weatherV3 } from '../../controller/phone/v3/weather.js';
import { installV3 } from '../../controller/phone/v3/install.js';
import { watchTokenV3 } from '../../controller/phone/v3/watchtoken.js';
import { syncV3 } from '../../controller/phone/v3/sync.js';
import { ipLocationHookV3 } from '../../controller/phone/v3/iplocation.js';
import { accountDeleteV3 } from '../../controller/phone/v3/accountdelete.js';
import { accountCodeV3, accountCodeVerifyV3 } from '../../controller/phone/v3/accountcode.js';
import { loginV3 } from '../../controller/phone/v3/login.js';
import { logoutV3 } from '../../controller/phone/v3/logout.js';
import { profileV3 } from '../../controller/phone/v3/profile.js';
import { RedeemBodySchema, PurchaseIosBodySchema, DeleteCodeBodySchema, LoginBodySchema, UserFeedQuerySchema, UserIdParamsSchema, WeatherBodySchema, PostIdParamsSchema, PostsQuerySchema, PutPostBodySchema } from '../../schemas/index.js';
import { SyncBodySchema } from '../../schemas/index.js';
import { InstallBodySchema, WatchTokenBodySchema } from '../../schemas/index.js';
import { ActivityIdParamsSchema, CommitBodySchema, DevLoginBodySchema, ProfileCommitBodySchema, ProfileImageParamsSchema, ProfileKindParamsSchema, ProfilePresignBodySchema, FeedQuerySchema, MediaParamsSchema, LogoutBodySchema, PresignBodySchema, RefreshBodySchema } from '../../schemas/index.js';

async function phoneRouterV3(fastify: FastifyInstance) {
  const isAuth = { onRequest: [fastify.authenticate('phone')] };
  const isAuthBigBody = { ...isAuth, bodyLimit: 8 * 1024 * 1024 };

  // A phone with location off has its place from the IP address (docs/data/server.md section 7): runs for the secured routes, after sign-in.
  fastify.addHook('preHandler', ipLocationHookV3);

  // UNSECURED ROUTES

  // The install's first call: public, made when the app is first opened, before anyone signs in (limited per address, like the sign-in).
  fastify.post('/download', { schema: { body: InstallBodySchema } }, installV3);
  fastify.post('/auth/refresh', { schema: { body: RefreshBodySchema } }, refreshTokenV3);
  fastify.post('/auth/login', { schema: { body: LoginBodySchema } }, loginV3);
  fastify.post('/auth/dev-login', { schema: { body: DevLoginBodySchema } }, devLoginV3); // local testing only: 404 unless DEV_LOGIN=true

  // SECURED ROUTES

  fastify.post('/auth/watch-token', { ...isAuth, schema: { body: WatchTokenBodySchema } }, watchTokenV3);
  fastify.post('/purchases/ios', { ...isAuth, schema: { body: PurchaseIosBodySchema } }, purchaseIosV3);
  // Its own list of hooks: the rate limiter adds its hook to the list a route is given, and `isAuth`'s is shared by all the routes above.
  fastify.post('/redeem', { onRequest: [fastify.authenticate('phone')], schema: { body: RedeemBodySchema } }, redeemV3);
  fastify.get('/profile', isAuth, profileV3);
  fastify.post('/account/delete-code', isAuth, accountCodeV3);
  fastify.post('/account/delete-code/verify', { ...isAuth, schema: { body: DeleteCodeBodySchema } }, accountCodeVerifyV3);
  fastify.delete('/account', { ...isAuth, schema: { body: DeleteCodeBodySchema } }, accountDeleteV3);
  fastify.post('/auth/logout', { ...isAuth, schema: { body: LogoutBodySchema } }, logoutV3);

  fastify.post('/sync', { ...isAuthBigBody, schema: { body: SyncBodySchema } }, syncV3);

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
}

export default phoneRouterV3;
