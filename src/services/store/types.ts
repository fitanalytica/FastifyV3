// docs/data/api.md section 15. A purchase as the store reports it, after its signature was checked. The dates and the price are the store's own (Apple: milliseconds, and the price in
// thousandths of the currency), kept as they are because the old app's `payments` table holds them that way.
export type StoreEnvironment = 'production' | 'sandbox';

export interface StoreTransaction {
  /** From the checked data, never from the request. */
  environment: StoreEnvironment;
  transactionId: string;
  /** The same as `transactionId` for a one-time purchase; the first one of a plan across its renewals. */
  originalTransactionId: string;
  productId: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  /** Milliseconds; none for a purchase that never ends. */
  expiresDate?: number;
  price?: number;
  currency?: string;
  storefront?: string;
  /** What the app put on the purchase (the user's `store_id`). */
  appAccountToken?: string;
  inAppOwnershipType?: string;
  transactionReason?: string;
  type?: string;
  subscriptionGroupIdentifier?: string;
}

export interface StoreRenewal {
  autoRenewStatus?: number;
  recentSubscriptionStartDate?: number;
}

export interface StoreNotification {
  uuid?: string;
  type: string;
  subtype?: string;
  environment: StoreEnvironment;
  transaction?: StoreTransaction;
  renewal?: StoreRenewal;
}

/** Checks what the App Store signed. A test replaces it (`setAppleVerifier`); the real one is `apple/verifier.ts`. */
export interface AppleVerifier {
  /** Throws when the signature or the app does not check out. */
  transaction(signedTransaction: string): Promise<StoreTransaction>;
  notification(signedPayload: string): Promise<StoreNotification>;
}
