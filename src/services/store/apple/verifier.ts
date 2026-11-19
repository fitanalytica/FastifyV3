import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Environment, SignedDataVerifier, type JWSTransactionDecodedPayload } from '@apple/app-store-server-library';
import { decodeJwt } from 'jose';
import { env } from '../../../config/env.js';
import { errors } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/codes.js';
import type { AppleVerifier, StoreEnvironment, StoreNotification, StoreTransaction } from '../types.js';

// docs/data/api.md section 15. What the App Store signs (a transaction from the phone, a notification from Apple) is checked here: its certificate chain must lead to Apple's root,
// and it must be for this app and for the environment it names. Nothing the phone says about it is believed. The roots are Apple's public ones (certs/apple, from
// https://www.apple.com/certificateauthority/); the chain of a real purchase ends at G3.
const CERTS = path.resolve(import.meta.dirname, '../../../../certs/apple');

let roots: Buffer[] | undefined;
const rootCertificates = () => (roots ??= ['AppleRootCA-G3.cer', 'AppleRootCA-G2.cer'].map((f) => readFileSync(path.join(CERTS, f))));

const verifiers = new Map<StoreEnvironment, SignedDataVerifier>();

function verifierFor(environment: StoreEnvironment): SignedDataVerifier {
  let v = verifiers.get(environment);
  if (!v) {
    const { clientId, appId } = env().apple;
    if (environment === 'production' && !appId) throw errors.Unavailable('Apple purchases are not set up (APPLE_APP_ID)', ErrorCode.STORE_UNAVAILABLE);
    v = new SignedDataVerifier(rootCertificates(), false, environment === 'production' ? Environment.PRODUCTION : Environment.SANDBOX, clientId, environment === 'production' ? appId : undefined);
    verifiers.set(environment, v);
  }
  return v;
}

/** The environment a signed value claims. It only picks which check to run: the check itself fails if the claim is false. */
function claimed(environment: unknown): StoreEnvironment {
  return environment === 'Production' ? 'production' : 'sandbox';
}

const text = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

function toTransaction(p: JWSTransactionDecodedPayload, environment: StoreEnvironment): StoreTransaction {
  return {
    environment,
    transactionId: String(p.transactionId),
    originalTransactionId: String(p.originalTransactionId ?? p.transactionId),
    productId: p.productId ?? '',
    purchaseDate: p.purchaseDate,
    originalPurchaseDate: p.originalPurchaseDate,
    expiresDate: p.expiresDate,
    price: p.price,
    currency: p.currency,
    storefront: p.storefront,
    appAccountToken: p.appAccountToken,
    inAppOwnershipType: text(p.inAppOwnershipType),
    transactionReason: text(p.transactionReason),
    type: text(p.type),
    subscriptionGroupIdentifier: p.subscriptionGroupIdentifier,
  };
}

export const appleVerifier: AppleVerifier = {
  async transaction(signed) {
    const environment = claimed(decodeJwt(signed).environment);
    return toTransaction(await verifierFor(environment).verifyAndDecodeTransaction(signed), environment);
  },
  async notification(signedPayload) {
    const outer = decodeJwt(signedPayload) as { data?: { environment?: string } };
    const environment = claimed(outer.data?.environment);
    const v = verifierFor(environment);
    const n = await v.verifyAndDecodeNotification(signedPayload);
    const tx = n.data?.signedTransactionInfo ? toTransaction(await v.verifyAndDecodeTransaction(n.data.signedTransactionInfo), environment) : undefined;
    const r = n.data?.signedRenewalInfo ? await v.verifyAndDecodeRenewalInfo(n.data.signedRenewalInfo) : undefined;
    return {
      uuid: n.notificationUUID,
      type: String(n.notificationType ?? ''),
      subtype: text(n.subtype),
      environment,
      transaction: tx,
      renewal: r ? { autoRenewStatus: r.autoRenewStatus, recentSubscriptionStartDate: r.recentSubscriptionStartDate } : undefined,
    } satisfies StoreNotification;
  },
};
