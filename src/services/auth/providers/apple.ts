import { readFile } from 'node:fs/promises';
import { importPKCS8, SignJWT } from 'jose';
import { env } from '../../../config/env.js';

// docs/data/api.md section 1b. Sign in with Apple's own calls: the authorization code is exchanged for a refresh token, which is kept so that deleting the
// account can revoke the user's grant (Apple requires it). Both calls need a client secret: a short-lived ES256 JWT signed with the Key from the developer account.

const AUDIENCE = 'https://appleid.apple.com';
const TIMEOUT_MS = 8000;

/** Whether the server can talk to Apple (team, key id and the key itself are set). */
export const appleConfigured = (): boolean => {
  const a = env().apple;
  return Boolean(a.teamId && a.keyId && (a.privateKey || a.privateKeyPath));
};

async function privateKey(): Promise<string> {
  const a = env().apple;
  return a.privateKey ? a.privateKey.replace(/\\n/g, '\n') : readFile(a.privateKeyPath!, 'utf8');
}

/** The client secret: valid five minutes, made for each call. */
export async function appleClientSecret(now: number = Math.floor(Date.now() / 1000), clientId: string = env().apple.clientId): Promise<string> {
  const a = env().apple;
  const key = await importPKCS8(await privateKey(), 'ES256');
  return new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: a.keyId }).setIssuer(a.teamId!).setSubject(clientId).setAudience(AUDIENCE).setIssuedAt(now).setExpirationTime(now + 300).sign(key);
}

async function post(path: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${AUDIENCE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Exchanges the authorization code for Apple's refresh token. A code belongs to the client that asked for it: the app's bundle id on iOS, the **Services ID** on Android (Apple's web sign-in), so `clientId`
 * is the audience of the ID token that came with it. Resolves `null` when it cannot be done (not set up, refused, no answer): signing in never depends on it.
 */
export async function exchangeAppleCode(code: string, clientId: string = env().apple.clientId): Promise<string | null> {
  if (!appleConfigured()) return null;
  try {
    const res = await post('/auth/token', { client_id: clientId, client_secret: await appleClientSecret(undefined, clientId), code, grant_type: 'authorization_code' });
    if (!res.ok) return null;
    const body = (await res.json()) as { refresh_token?: unknown };
    return typeof body.refresh_token === 'string' && body.refresh_token.length <= 255 ? body.refresh_token : null;
  } catch {
    return null;
  }
}

/**
 * Revokes the user's grant with Apple (account deletion). Resolves whether Apple accepted it; never throws, so a failure cannot block the deletion. The refresh token belongs to the client it was made for (the
 * app on iOS, the Services ID on Android) and the row does not say which, so it is tried with the app first and, if Apple refuses, with the Services ID.
 */
export async function revokeAppleToken(refreshToken: string): Promise<boolean> {
  if (!appleConfigured()) return false;
  const { clientId, servicesId } = env().apple;
  for (const client of [clientId, servicesId]) {
    try {
      const res = await post('/auth/revoke', { client_id: client, client_secret: await appleClientSecret(undefined, client), token: refreshToken, token_type_hint: 'refresh_token' });
      if (res.ok) return true;
    } catch {
      // try the next one
    }
  }
  return false;
}
