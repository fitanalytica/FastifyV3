import { Type } from '@sinclair/typebox';

/** GET /phone/v3/me/state?catalog=<version>: the versions of the catalogue and of the ad rules the phone already holds; each comes back whole only when it has changed (docs/data/api.md section 15). */
export const StateQuerySchema = Type.Object({
  catalog: Type.Optional(Type.String({ pattern: '^[0-9a-f]{12}$' })),
  /** The version of the ad rules the phone holds, and its platform (the rules can differ by platform; `ios` when not said). */
  ads: Type.Optional(Type.String({ pattern: '^[0-9a-f]{12}$' })),
  platform: Type.Optional(Type.Union([Type.Literal('ios'), Type.Literal('android')])),
});

/** POST /phone/v3/purchases/ios: the transaction exactly as the store signed it (`verificationResultIOS`, a JWS). The server checks the signature itself. */
export const PurchaseIosBodySchema = Type.Object({ signedTransaction: Type.String({ minLength: 20, maxLength: 20000 }) });

/**
 * POST /phone/v3/purchases/android: what react-native-iap gives for a Google Play purchase. Only the product and the token are believed: the server asks Google about the token. `price` and `currency` are
 * the phone's reading of what was paid (kept for reports only, never used to decide anything).
 */
export const PurchaseAndroidBodySchema = Type.Object({
  productId: Type.String({ minLength: 1, maxLength: 100 }),
  purchaseToken: Type.String({ minLength: 10, maxLength: 4000 }),
  price: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
  currency: Type.Optional(Type.String({ pattern: '^[A-Za-z]{3}$' })),
});

/** POST /store/v3/playstore: a Pub/Sub push of Google Play's real-time developer notification (the message's data is base64 JSON). */
export const PlayNotificationBodySchema = Type.Object({
  message: Type.Object({ data: Type.String({ minLength: 4, maxLength: 100000 }), messageId: Type.Optional(Type.String()) }, { additionalProperties: true }),
  subscription: Type.Optional(Type.String()),
});

/** POST /store/v3/appstore: the App Store's notification (App Store Server Notifications v2). */
export const AppStoreNotificationBodySchema = Type.Object({ signedPayload: Type.String({ minLength: 20, maxLength: 100000 }) });

/** POST /phone/v3/redeem: an invite code, as typed or from a link (`ABCD-EFGH`; the dash, the case and spaces do not matter). */
export const RedeemBodySchema = Type.Object({ code: Type.String({ minLength: 1, maxLength: 40 }) });
