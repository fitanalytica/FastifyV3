import { createHash } from 'node:crypto';
import { jwtVerify } from 'jose';
import { env } from '../../../config/env.js';
import { errors } from '../../../errors/AppError.js';
import { ErrorCode } from '../../../errors/codes.js';
import { keysFor, type Provider } from './keys.js';

export type { Provider };

// docs/data/api.md section 1b. The provider's ID token is checked here and the user is its `sub`: signature against the provider's published keys (cached),
// issuer, audience (our own app, so a token made for another app is refused), expiry, and the nonce of this sign-in.

export interface ProviderIdentity {
  /** The provider's id of the user: what `userlogin.applegoogleid` holds. */
  sub: string;
  email: string | null;
  givenName: string | null;
  familyName: string | null;
  /** The audience the token was made for: the app's bundle id (iOS) or the Services ID (Android's web sign-in). Apple's code exchange and revoke must use the same client. */
  audience: string;
}

const ISSUERS: Record<Provider, string[]> = { apple: ['https://appleid.apple.com'], google: ['https://accounts.google.com', 'accounts.google.com'] };

const refused = (why: string) => errors.Unauthorized(`The sign-in was not accepted: ${why}`, ErrorCode.LOGIN_REFUSED);

function audiences(provider: Provider): string[] {
  const e = env();
  // Apple: the app itself (iOS) and the Services ID (Android signs in through Apple's web page, which makes tokens for it).
  return provider === 'apple' ? [e.apple.clientId, e.apple.servicesId] : e.google.clientIds;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Verifies the token and returns who it is for. 503 when the provider is not set up here, 401 `LOGIN_REFUSED` for anything wrong with the token. */
export async function verifyIdToken(provider: Provider, idToken: string, rawNonce?: string): Promise<ProviderIdentity> {
  const audience = audiences(provider);
  if (!audience.length) throw errors.Unavailable(`Sign in with ${provider} is not set up on the server`, ErrorCode.LOGIN_REFUSED);
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keysFor(provider), { issuer: ISSUERS[provider], audience, algorithms: ['RS256'], clockTolerance: 30 }));
  } catch (e) {
    throw refused(e instanceof Error ? e.message : 'invalid token');
  }
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 50) throw refused('no user in the token');
  // The nonce ties the token to this sign-in. Apple's token holds what the app sent Apple (the raw value or its hash) and the app always sends it, so for Apple
  // a token with a nonce needs ours to match, and one without is refused when ours was sent. Google's iOS SDK puts a nonce of its own in the token that the app
  // never sees: without ours there is nothing to compare (the token's short life and audience still hold), and with ours it must match.
  if (typeof payload.nonce === 'string') {
    if (rawNonce ? payload.nonce !== rawNonce && payload.nonce.toLowerCase() !== sha256hex(rawNonce) : provider === 'apple') throw refused('the nonce does not match');
  } else if (rawNonce && provider === 'apple') {
    throw refused('the token has no nonce');
  }
  const aud = ([] as string[]).concat(payload.aud ?? []).find((a) => audience.includes(a)) ?? audience[0];
  return {
    sub: payload.sub,
    audience: aud,
    email: text(payload.email),
    givenName: text(payload.given_name),
    familyName: text(payload.family_name),
  };
}
