import { Type } from '@sinclair/typebox';
import { Uuid } from './common.js';

export const RefreshBodySchema = Type.Object({ refreshToken: Type.String({ minLength: 1 }) });

/** Without a refresh token, logout signs out every device of the user. */
export const LogoutBodySchema = Type.Object({ refreshToken: Type.Optional(Type.String({ minLength: 1 })) });

/** Local testing only. */
export const DevLoginBodySchema = Type.Object({
  deviceid: Uuid,
  downloadid: Type.Optional(Uuid),
  device: Type.Optional(Type.String()),
  platform: Type.Optional(Type.String()),
  /** Sign in as exactly this user, who must already be in the local database. Wins over `provider`. */
  userid: Type.Optional(Uuid),
  /** Sign in as the local user mapped to this provider (env DEV_USER_APPLE / DEV_USER_GOOGLE). */
  provider: Type.Optional(Type.Union([Type.Literal('apple'), Type.Literal('google')])),
  watch: Type.Optional(Type.Boolean()),
});
