import { GoogleAuth } from 'google-auth-library';
import { env } from '../../../config/env.js';
import { errors } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/codes.js';
import { PlayError, type PlayClient, type PlayProduct, type PlaySubscription } from './types.js';

// docs/data/api.md section 15. The real client of the Google Play Developer API (androidpublisher v3), over plain HTTPS with an access token from the server's service account (the usual
// `GOOGLE_APPLICATION_CREDENTIALS` key file, or the workload identity of the host). Without credentials every call answers 503 (`STORE_UNAVAILABLE`), the same as Apple's missing app id.
const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

let auth: GoogleAuth | undefined;

async function token(): Promise<string> {
  try {
    auth ??= new GoogleAuth({ scopes: [SCOPE] });
    const t = await auth.getAccessToken();
    if (t) return t;
  } catch {
    // Falls through to the same answer: there is no way to ask Play.
  }
  throw errors.Unavailable('Google Play purchases are not set up (no service account credentials)', ErrorCode.STORE_UNAVAILABLE);
}

async function call(method: 'GET' | 'POST', path: string): Promise<unknown> {
  const r = await fetch(`${BASE}/${encodeURIComponent(env().play.packageName)}/${path}`, {
    method,
    headers: { authorization: `Bearer ${await token()}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new PlayError(r.status, `Google Play answered ${r.status}`);
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}

const ms = (rfc3339: unknown) => (typeof rfc3339 === 'string' && rfc3339 ? Date.parse(rfc3339) : undefined);
const enc = encodeURIComponent;

export const playClient: PlayClient = {
  async product(productId, tokenValue) {
    const d = (await call('GET', `purchases/products/${enc(productId)}/tokens/${enc(tokenValue)}`)) as Record<string, unknown>;
    return {
      orderId: String(d.orderId ?? ''),
      purchaseState: Number(d.purchaseState ?? 0),
      acknowledgementState: Number(d.acknowledgementState ?? 0),
      consumptionState: Number(d.consumptionState ?? 0),
      regionCode: typeof d.regionCode === 'string' ? d.regionCode : undefined,
      obfuscatedAccountId: typeof d.obfuscatedExternalAccountId === 'string' ? d.obfuscatedExternalAccountId : undefined,
      purchaseTimeMillis: d.purchaseTimeMillis ? Number(d.purchaseTimeMillis) : undefined,
      // purchaseType 0 is a license tester's purchase (absent for a real one).
      test: d.purchaseType === 0,
    } satisfies PlayProduct;
  },
  async subscription(tokenValue) {
    const d = (await call('GET', `purchases/subscriptionsv2/tokens/${enc(tokenValue)}`)) as Record<string, any>;
    const line = Array.isArray(d.lineItems) ? d.lineItems[0] : undefined;
    return {
      productId: String(line?.productId ?? ''),
      latestOrderId: String(d.latestOrderId ?? ''),
      state: String(d.subscriptionState ?? ''),
      startTimeMillis: ms(d.startTime),
      expiryTimeMillis: ms(line?.expiryTime),
      regionCode: typeof d.regionCode === 'string' ? d.regionCode : undefined,
      obfuscatedAccountId: d.externalAccountIdentifiers?.obfuscatedExternalAccountId,
      acknowledged: d.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      test: d.testPurchase !== undefined && d.testPurchase !== null,
    } satisfies PlaySubscription;
  },
  async acknowledgeProduct(productId, tokenValue) {
    await call('POST', `purchases/products/${enc(productId)}/tokens/${enc(tokenValue)}:acknowledge`);
  },
  async consumeProduct(productId, tokenValue) {
    await call('POST', `purchases/products/${enc(productId)}/tokens/${enc(tokenValue)}:consume`);
  },
  async acknowledgeSubscription(productId, tokenValue) {
    await call('POST', `purchases/subscriptions/${enc(productId)}/tokens/${enc(tokenValue)}:acknowledge`);
  },
};
