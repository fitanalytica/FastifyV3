import { Type } from '@sinclair/typebox';
import { Uuid } from './common.js';

export const RefreshBodySchema = Type.Object({ refreshToken: Type.String({ minLength: 1 }) });

/** Without a refresh token, logout signs out every device of the user. */
export const LogoutBodySchema = Type.Object({ refreshToken: Type.Optional(Type.String({ minLength: 1 })) });

/**
 * POST /phone/v3/auth/login (docs/data/api.md section 1b): the credential the provider gave the app. `idToken` is verified by the server (signature, issuer,
 * audience, expiry, `nonce`); the user is the token's `sub`, never anything the app says. Apple also gives an `authCode` (exchanged for the refresh token that
 * deleting the account must revoke) and, on the very first sign-in only, the name (`fullName`).
 */
export const LoginBodySchema = Type.Object({
  provider: Type.Union([Type.Literal('apple'), Type.Literal('google')]),
  idToken: Type.String({ minLength: 20, maxLength: 8000 }),
  /** The raw nonce the app made for this sign-in (the token holds it or its SHA-256). */
  nonce: Type.Optional(Type.String({ minLength: 8, maxLength: 200 })),
  authCode: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  fullName: Type.Optional(Type.Object({ givenName: Type.Optional(Type.String({ maxLength: 100 })), familyName: Type.Optional(Type.String({ maxLength: 100 })) })),
  deviceid: Uuid,
  downloadid: Type.Optional(Uuid),
  device: Type.Optional(Type.String({ maxLength: 100 })),
  platform: Type.Optional(Type.String({ maxLength: 20 })),
});

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
