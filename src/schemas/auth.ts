import { Type } from '@sinclair/typebox';
import { Uuid } from './common.js';

export const RefreshBodySchema = Type.Object({ refreshToken: Type.String({ minLength: 1 }) });

/** Without a refresh token, logout signs out every device of the user. */
export const LogoutBodySchema = Type.Object({ refreshToken: Type.Optional(Type.String({ minLength: 1 })) });

/**
 * What the phone says about itself (docs/data/api.md section 1d): the system and app versions, the device, its time zone and region. Sent with the sign-in and again by `PUT /device` when something
 * changed. Everything is optional, and a text longer than its column is cut, not refused. `region` is the device's country (2 letters): a first guess for the place when the IP lookup fails.
 * `fcmToken` is the push token (kept in `downloads.fcm_token`).
 */
export const DeviceInfoSchema = Type.Object({
  os: Type.Optional(Type.String({ maxLength: 200 })),
  appVersion: Type.Optional(Type.String({ maxLength: 200 })),
  model: Type.Optional(Type.String({ maxLength: 200 })),
  code: Type.Optional(Type.String({ maxLength: 200 })),
  manufacturer: Type.Optional(Type.String({ maxLength: 200 })),
  timezone: Type.Optional(Type.String({ maxLength: 100 })),
  region: Type.Optional(Type.String({ pattern: '^[A-Za-z]{2}$' })),
  /** The push token; `null` takes it away (the user turned notifications off): Null comes first in the union, the server's coercion would turn a null into an empty text otherwise. */
  fcmToken: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 4096 })])),
});

/**
 * POST /phone/v3/download and /wearable/v3/download (docs/data/api.md section 1d): the install's first call, made when the app is opened for the first time, signed in or not. Public: no token.
 * `downloadid` is the install's id and `deviceid` the app's own device id (both kept in the Keychain by the app).
 */
export const InstallBodySchema = Type.Object({
  downloadid: Uuid,
  deviceid: Uuid,
  platform: Type.Optional(Type.String({ maxLength: 20 })),
  deviceInfo: Type.Optional(DeviceInfoSchema),
});

/** POST /phone/v3/auth/watch-token (docs/data/api.md section 1d): the phone gives the watch its own sign-in. The watch's own ids and what it says about itself. */
export const WatchTokenBodySchema = Type.Object({
  deviceid: Uuid,
  downloadid: Type.Optional(Uuid),
  device: Type.Optional(Type.String({ maxLength: 100 })),
  platform: Type.Optional(Type.String({ maxLength: 20 })),
  deviceInfo: Type.Optional(DeviceInfoSchema),
});

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
  deviceInfo: Type.Optional(DeviceInfoSchema),
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
  deviceInfo: Type.Optional(DeviceInfoSchema),
});
