import { OAuth2Client } from 'google-auth-library';
import { env } from '../../../config/env.js';
import { errors } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/codes.js';
import type { PlayNotifyAuth } from './types.js';

// docs/data/api.md section 15. Google Pub/Sub pushes the real-time developer notifications with an OpenID Connect token of the service account the subscription was set up with. It is accepted only
// when it is signed by Google, made for our audience (the subscription's push endpoint setting) and by that account, with a verified e-mail. Without the two settings the route answers 503.
const client = new OAuth2Client();

export const playNotifyAuth: PlayNotifyAuth = {
  async verify(authorization) {
    const { notifyAudience, notifyServiceAccount } = env().play;
    if (!notifyAudience || !notifyServiceAccount) throw errors.Unavailable('Play notifications are not set up (PLAY_NOTIFY_AUDIENCE, PLAY_NOTIFY_SERVICE_ACCOUNT)', ErrorCode.STORE_UNAVAILABLE);
    const idToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!idToken) throw errors.Unauthorized('Missing token');
    let payload;
    try {
      payload = (await client.verifyIdToken({ idToken, audience: notifyAudience })).getPayload();
    } catch {
      throw errors.Unauthorized('Invalid token');
    }
    if (!payload || payload.email !== notifyServiceAccount || payload.email_verified !== true) throw errors.Forbidden('Not our notification account');
  },
};
