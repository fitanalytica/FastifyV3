import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

export type Provider = 'apple' | 'google';

const KEY_URLS: Record<Provider, string> = { apple: 'https://appleid.apple.com/auth/keys', google: 'https://www.googleapis.com/oauth2/v3/certs' };

const remote = new Map<Provider, JWTVerifyGetKey>();

/** The provider's published keys (fetched on first use, then cached and refreshed by `jose` when a new key id appears). A test replaces this module. */
export function keysFor(provider: Provider): JWTVerifyGetKey {
  let keys = remote.get(provider);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(KEY_URLS[provider]), { cooldownDuration: 30_000, timeoutDuration: 5000 });
    remote.set(provider, keys);
  }
  return keys;
}
