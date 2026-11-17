import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { LoginBody, LoginResponse } from '../../types/index.js';
import { registerDownload } from './downloads.js';
import { loginDevice } from './loginDevice.js';
import { exchangeAppleCode } from './providers/apple.js';
import { verifyIdToken } from './providers/verify.js';

// docs/data/api.md section 1b. Sign in with Apple or Google: the provider's token is verified, the user is found by its `sub` (or made, the first time), the
// install is registered, and the device gets its tokens from the same `loginDevice` as everywhere. Whether this is a NEW user is not decided here: it is the
// profile (GET /profile answers 404 until the setup has saved one), as it has always been. Nothing here ends a session: only logout or a refused token does.

/** `userlogin.email` is 60 characters: a longer address is left out rather than cut (a cut address is a wrong address). */
const emailFor = (email: string | null) => (email && email.length <= 60 ? email : null);

export async function login(app: FastifyInstance, b: LoginBody): Promise<LoginResponse> {
  const identity = await verifyIdToken(b.provider, b.idToken, b.nonce);
  const w = app.pg.writer;
  const user = await w.query(
    `INSERT INTO userlogin (userid, stage, loginused, email, applegoogleid) VALUES ($1, 0, $2::login_type_enum, $3, $4)
     ON CONFLICT (applegoogleid) DO UPDATE SET email = coalesce(EXCLUDED.email, userlogin.email)
     RETURNING userid`,
    [randomUUID(), b.provider, emailFor(identity.email), identity.sub],
  );
  const userid = user.rows[0].userid as string;
  const downloadid = b.downloadid ?? randomUUID();
  await registerDownload(app, { downloadid, userid, platform: b.platform });
  const tokens = await loginDevice(app, { deviceid: b.deviceid, userid, downloadid, applegoogleid: identity.sub, device: b.device ?? 'phone' });
  // Apple: the refresh token that deleting the account must revoke. A failure is not a failed sign-in (the user is in); it is only logged.
  if (b.provider === 'apple' && b.authCode) {
    const refresh = await exchangeAppleCode(b.authCode);
    if (refresh) await w.query('UPDATE usertokens SET apple_refresh_token = $2 WHERE deviceid = $1', [b.deviceid, refresh]);
    else app.log.warn({ userid }, 'Apple refresh token not kept (exchange failed or not set up)');
  }
  return {
    ...tokens,
    userid,
    downloadid,
    email: identity.email,
    // Apple tells the name only at the first sign-in, and only to the app: it is passed on as the app sent it.
    givenName: identity.givenName ?? b.fullName?.givenName?.trim() ?? null,
    familyName: identity.familyName ?? b.fullName?.familyName?.trim() ?? null,
  };
}
