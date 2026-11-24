// docs/data/api.md section 15. What Google Play tells us about a purchase, after the server asked Play itself (nothing the phone says about a purchase is believed).

/** A one-time product (what the app sells as packs and protection days). */
export interface PlayProduct {
  orderId: string;
  /** 0 purchased, 1 canceled, 2 pending (not paid yet). */
  purchaseState: number;
  /** 0 yet to be acknowledged, 1 acknowledged. */
  acknowledgementState: number;
  /** 0 yet to be consumed, 1 consumed. */
  consumptionState: number;
  regionCode?: string;
  /** What the app put on the purchase (the user's `store_id`). */
  obfuscatedAccountId?: string;
  purchaseTimeMillis?: number;
  /** A license tester's purchase: it counts in the sandbox tables, never in production's. */
  test: boolean;
}

/** A subscription (no plan is on sale today; the rules are ready). */
export interface PlaySubscription {
  productId: string;
  /** The order of the latest period: `GPA.1234-5678-9012-34567` for the first, then `...0`, `...1` for each renewal. */
  latestOrderId: string;
  /** `SUBSCRIPTION_STATE_ACTIVE`, `..._EXPIRED`, `..._CANCELED`, … */
  state: string;
  startTimeMillis?: number;
  expiryTimeMillis?: number;
  regionCode?: string;
  obfuscatedAccountId?: string;
  acknowledged: boolean;
  test: boolean;
}

/** Asks Google Play. A test replaces it (`setPlayClient`); the real one is `google/client.ts`. Every call throws `PlayError` when Play says no. */
export interface PlayClient {
  product(productId: string, token: string): Promise<PlayProduct>;
  subscription(token: string): Promise<PlaySubscription>;
  acknowledgeProduct(productId: string, token: string): Promise<void>;
  /** Consumes a consumable (it can be bought again); this also acknowledges it. */
  consumeProduct(productId: string, token: string): Promise<void>;
  acknowledgeSubscription(productId: string, token: string): Promise<void>;
}

/** Play said no. `status` is the HTTP status: 404 or 410 the token is not a purchase of this app (or is gone), 401 or 403 the server's own access to Play is wrong. */
export class PlayError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Checks that a notification really comes from our Pub/Sub subscription. Throws when it does not. A test replaces it (`setPlayNotifyAuth`). */
export interface PlayNotifyAuth {
  verify(authorization: string | undefined): Promise<void>;
}

/** The real-time developer notification, decoded (Pub/Sub's `message.data`). Only what is read. */
export interface PlayNotification {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: { notificationType?: number; purchaseToken: string; subscriptionId: string };
  oneTimeProductNotification?: { notificationType?: number; purchaseToken: string; sku: string };
  voidedPurchaseNotification?: { purchaseToken: string; orderId?: string; productType?: number; refundType?: number };
  testNotification?: { version?: string };
}
