import { test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify, type JWK } from 'jose';
import { build, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';

// Sign in with Apple and Google (docs/data/api.md section 1b). The providers are stand-ins: their published keys are a local key set (no request leaves the
// machine), and Apple's own calls (token exchange, revoke) are a stubbed `fetch`.
const keys = vi.hoisted(() => ({ jwks: { keys: [] as JWK[] } }));
vi.mock('../../src/services/auth/providers/keys.js', async () => {
  const { createLocalJWKSet: local } = await import('jose');
  return { keysFor: () => local(keys.jwks) };
});

import { appleClientSecret, exchangeAppleCode, revokeAppleToken } from '../../src/services/auth/providers/apple.js';
import { probe } from '../helpers/viaSync.js';

let app: TestApp;
let signing: CryptoKey;
let other: CryptoKey;
let ec: { privateKey: string; publicKey: CryptoKey };
const made: string[] = [];

const APPLE_ID = 'com.fitanalytica';
const GOOGLE_ID = '331152646888-test.apps.googleusercontent.com';

beforeAll(async () => {
  process.env.LOGIN_RATE_LIMIT = '1000'; // these tests sign in many times from one address
  app = await build();
  const pair = await generateKeyPair('RS256');
  signing = pair.privateKey;
  keys.jwks.keys = [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }];
  other = (await generateKeyPair('RS256')).privateKey;
  const e = await generateKeyPair('ES256', { extractable: true });
  ec = { privateKey: await exportPKCS8(e.privateKey), publicKey: e.publicKey };
});
afterAll(async () => {
  delete process.env.LOGIN_RATE_LIMIT;
  for (const sub of made) {
    const r = await app.pg.writer.query('DELETE FROM userlogin WHERE applegoogleid = $1 RETURNING userid', [sub]);
    if (r.rows[0]) await app.pg.writer.query('DELETE FROM downloads WHERE userid = $1', [r.rows[0].userid]);
  }
  await app.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const setup = () => {
  vi.stubEnv('GOOGLE_CLIENT_IDS', GOOGLE_ID);
  vi.stubEnv('APPLE_CLIENT_ID', APPLE_ID);
  vi.stubEnv('APPLE_TEAM_ID', 'TEAM123456');
  vi.stubEnv('APPLE_KEY_ID', 'KEY1234567');
  vi.stubEnv('APPLE_PRIVATE_KEY', ec.privateKey);
};

type Claims = { sub?: string; iss?: string; aud?: string; nonce?: string; email?: string; given_name?: string; family_name?: string; exp?: number };
const token = (provider: 'apple' | 'google', c: Claims = {}, key: CryptoKey = signing) => {
  const sub = c.sub ?? `${provider}-${randomUUID().slice(0, 18)}`;
  made.push(sub);
  const { iss, aud, exp, ...rest } = c;
  return new SignJWT({ ...rest, sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(iss ?? (provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com'))
    .setAudience(aud ?? (provider === 'apple' ? APPLE_ID : GOOGLE_ID))
    .setIssuedAt()
    .setExpirationTime(exp ?? '10m')
    .sign(key)
    .then((jwt) => ({ jwt, sub }));
};
const login = (body: object) => app.inject({ method: 'POST', url: '/phone/v3/auth/login', payload: { deviceid: randomUUID(), ...body } as object });
const rows = async (sub: string) => (await app.pg.writer.query('SELECT * FROM userlogin WHERE applegoogleid = $1', [sub])).rows;

test('Google: the user is made from the token, signed in on this device, and the tokens work', async () => {
  setup();
  const { jwt, sub } = await token('google', { email: 'asha@example.com', given_name: 'Asha', family_name: 'Rao' });
  const res = await login({ provider: 'google', idToken: jwt });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body).toMatchObject({ email: 'asha@example.com', givenName: 'Asha', familyName: 'Rao' });
  expect(await rows(sub)).toMatchObject([{ userid: body.userid, loginused: 'google', email: 'asha@example.com', applegoogleid: sub }]);
  expect((await probe(app, body.accessToken)).statusCode).toBe(200);
});

test('the same person again is the same user (on another device too); the id the app says is never trusted', async () => {
  setup();
  const { jwt, sub } = await token('google');
  const first = (await login({ provider: 'google', idToken: jwt })).json();
  const again = (await login({ provider: 'google', idToken: (await token('google', { sub })).jwt })).json();
  expect(again.userid).toBe(first.userid);
  expect(await rows(sub)).toHaveLength(1);
  // an `userid` in the body is not part of the contract and changes nothing
  const lie = (await login({ provider: 'google', idToken: (await token('google', { sub })).jwt, userid: randomUUID() })).json();
  expect(lie.userid).toBe(first.userid);
});

test('a token that is not ours is refused: wrong keys, wrong app, wrong issuer, expired', async () => {
  setup();
  const refused = async (jwt: string, provider: 'apple' | 'google' = 'google') => {
    const res = await login({ provider, idToken: jwt });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('LOGIN_REFUSED');
  };
  await refused((await token('google', {}, other)).jwt);
  await refused((await token('google', { aud: 'someone-elses-app.apps.googleusercontent.com' })).jwt);
  await refused((await token('google', { iss: 'https://evil.example.com' })).jwt);
  await refused((await token('google', { exp: Math.floor(Date.now() / 1000) - 3600 })).jwt);
  await refused((await token('apple', { aud: 'com.other.app' })).jwt, 'apple');
  // a Google token is not an Apple token
  await refused((await token('google')).jwt, 'apple');
  expect((await login({ provider: 'google', idToken: 'x'.repeat(30) })).statusCode).toBe(401);
});

test('the nonce ties the token to this sign-in: the raw value or its hash, and a token with one needs it', async () => {
  setup();
  const raw = 'a-random-nonce-value';
  const hashed = createHash('sha256').update(raw).digest('hex');
  expect((await login({ provider: 'apple', idToken: (await token('apple', { nonce: hashed })).jwt, nonce: raw })).statusCode).toBe(200);
  expect((await login({ provider: 'apple', idToken: (await token('apple', { nonce: raw })).jwt, nonce: raw })).statusCode).toBe(200);
  expect((await login({ provider: 'apple', idToken: (await token('apple', { nonce: hashed })).jwt, nonce: 'another-nonce-value' })).statusCode).toBe(401);
  expect((await login({ provider: 'apple', idToken: (await token('apple', { nonce: hashed })).jwt })).statusCode).toBe(401);
  // Google's iOS SDK adds a nonce the app never sees: no nonce from the app is accepted for Google (and when the app sends one it must match)
  expect((await login({ provider: 'google', idToken: (await token('google', { nonce: 'sdk-made-nonce-value' })).jwt })).statusCode).toBe(200);
  expect((await login({ provider: 'google', idToken: (await token('google', { nonce: 'sdk-made-nonce-value' })).jwt, nonce: 'another-nonce-value' })).statusCode).toBe(401);
  // Apple's token must carry the nonce the app made
  expect((await login({ provider: 'apple', idToken: (await token('apple')).jwt, nonce: raw })).statusCode).toBe(401);
});

test('a provider that is not set up answers 503, not a sign-in', async () => {
  vi.stubEnv('GOOGLE_CLIENT_IDS', '');
  const res = await login({ provider: 'google', idToken: (await token('google')).jwt });
  expect(res.statusCode).toBe(503);
  expect(res.json().code).toBe('LOGIN_REFUSED');
});

test('Apple: the code is exchanged and Apple\'s refresh token is kept for the device; the name comes as the app sent it', async () => {
  setup();
  const fetchMock = vi.fn(async (_url: string, init?: { body?: URLSearchParams }) => ({ ok: true, json: async () => ({ refresh_token: 'r-apple-123', code: init?.body?.get('code') }) }));
  vi.stubGlobal('fetch', fetchMock);
  const { jwt, sub } = await token('apple', { email: 'abc@privaterelay.appleid.com' });
  const deviceid = randomUUID();
  const res = await login({ provider: 'apple', idToken: jwt, authCode: 'code-1', deviceid, fullName: { givenName: ' Asha ', familyName: 'Rao' } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ givenName: 'Asha', familyName: 'Rao', email: 'abc@privaterelay.appleid.com' });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
  expect(url).toBe('https://appleid.apple.com/auth/token');
  expect(init.body.get('grant_type')).toBe('authorization_code');
  expect(init.body.get('client_id')).toBe(APPLE_ID);
  expect(init.body.get('code')).toBe('code-1');
  const stored = await app.pg.writer.query('SELECT apple_refresh_token FROM usertokens WHERE deviceid = $1', [deviceid]);
  expect(stored.rows[0].apple_refresh_token).toBe('r-apple-123');
  expect((await rows(sub))[0].loginused).toBe('apple');
});

test('Apple does not answer, or refuses the code: the user is still signed in', async () => {
  setup();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  const deviceid = randomUUID();
  expect((await login({ provider: 'apple', idToken: (await token('apple')).jwt, authCode: 'bad', deviceid })).statusCode).toBe(200);
  expect((await app.pg.writer.query('SELECT apple_refresh_token FROM usertokens WHERE deviceid = $1', [deviceid])).rows[0].apple_refresh_token).toBeNull();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
  expect((await login({ provider: 'apple', idToken: (await token('apple')).jwt, authCode: 'x' })).statusCode).toBe(200);
});

test('an address longer than the column is left out, not cut', async () => {
  setup();
  const { jwt, sub } = await token('google', { email: `${'a'.repeat(70)}@example.com` });
  expect((await login({ provider: 'google', idToken: jwt })).statusCode).toBe(200);
  expect((await rows(sub))[0].email).toBeNull();
});

test('the client secret for Apple: ES256, from our team and key, for Apple, a few minutes', async () => {
  setup();
  const secret = await appleClientSecret(1_800_000_000);
  const { payload, protectedHeader } = await jwtVerify(secret, ec.publicKey, { currentDate: new Date(1_800_000_100 * 1000) });
  expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
  expect(payload).toMatchObject({ iss: 'TEAM123456', sub: APPLE_ID, aud: 'https://appleid.apple.com', iat: 1_800_000_000, exp: 1_800_000_300 });
});

test('revoking: Apple is told, and a refusal or no answer is false, never a throw; not set up is false without a call', async () => {
  setup();
  const ok = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', ok);
  expect(await revokeAppleToken('r-1')).toBe(true);
  const [url, init] = ok.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
  expect(url).toBe('https://appleid.apple.com/auth/revoke');
  expect(init.body.get('token')).toBe('r-1');
  expect(init.body.get('token_type_hint')).toBe('refresh_token');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  expect(await revokeAppleToken('r-1')).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
  expect(await revokeAppleToken('r-1')).toBe(false);
  expect(await exchangeAppleCode('c')).toBeNull();
  const none = vi.fn();
  vi.stubGlobal('fetch', none);
  vi.stubEnv('APPLE_TEAM_ID', '');
  expect(await revokeAppleToken('r-1')).toBe(false);
  expect(none).not.toHaveBeenCalled();
});

test('a body that is not a sign-in is refused', async () => {
  expect((await login({ provider: 'facebook', idToken: 'x'.repeat(30) })).statusCode).toBe(400);
  expect((await login({ provider: 'google' })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/phone/v3/auth/login', payload: { provider: 'google', idToken: 'x'.repeat(30) } })).statusCode).toBe(400);
});

test('the Apple key may be given as base64 of the PEM', async () => {
  vi.stubEnv('APPLE_TEAM_ID', 'TEAM123456');
  vi.stubEnv('APPLE_KEY_ID', '');
  vi.stubEnv('APPLE_SIGNIN_KEYID', 'KEY1234567');
  vi.stubEnv('APPLE_PRIVATE_KEY', '');
  vi.stubEnv('APPLE_SIGNIN_PRIVATE_KEY_BASE64', Buffer.from(ec.privateKey).toString('base64'));
  const { payload } = await jwtVerify(await appleClientSecret(1_800_000_000), ec.publicKey, { currentDate: new Date(1_800_000_100 * 1000) });
  expect(payload.iss).toBe('TEAM123456');
});

// Android signs in with Apple through Apple's web page and a Services ID (docs/data/api.md section 1b): the token is for the Services ID, and so are the code exchange and the revoke.
const SERVICES_ID = 'com.fitanalytica.weblogin.sid';

test('Apple on Android: a token made for the Services ID is accepted (with the raw nonce the app sent), and one for another app is still refused', async () => {
  setup();
  const nonce = randomUUID();
  const { jwt, sub } = await token('apple', { aud: SERVICES_ID, nonce, email: 'web@example.com' });
  const res = await login({ provider: 'apple', idToken: jwt, nonce });
  expect(res.statusCode).toBe(200);
  expect(await rows(sub)).toMatchObject([{ loginused: 'apple', applegoogleid: sub }]);
  const wrong = await token('apple', { aud: 'com.someone.else' });
  expect((await login({ provider: 'apple', idToken: wrong.jwt })).statusCode).toBe(401);
});

test('Apple on Android: the code is exchanged as the Services ID (its client id and a secret made for it), and the refresh token is kept', async () => {
  setup();
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: URLSearchParams }) => { calls.push({ url, body: init.body }); return { ok: true, json: async () => ({ refresh_token: 'r-web' }) }; }));
  const nonce = randomUUID();
  const { jwt } = await token('apple', { aud: SERVICES_ID, nonce });
  const deviceid = randomUUID();
  const res = await login({ provider: 'apple', idToken: jwt, nonce, authCode: 'web-code', deviceid });
  expect(res.statusCode).toBe(200);
  expect(calls[0].body.get('client_id')).toBe(SERVICES_ID);
  const secret = await jwtVerify(calls[0].body.get('client_secret')!, ec.publicKey);
  expect(secret.payload.sub).toBe(SERVICES_ID);
  expect((await app.pg.writer.query('SELECT apple_refresh_token FROM usertokens WHERE deviceid = $1', [deviceid])).rows[0].apple_refresh_token).toBe('r-web');
  // The iOS sign-in still exchanges as the app.
  calls.length = 0;
  const ios = await token('apple', {});
  await login({ provider: 'apple', idToken: ios.jwt, authCode: 'ios-code' });
  expect(calls[0].body.get('client_id')).toBe(APPLE_ID);
});

test('revoking a token made for the Services ID: Apple refuses the app first, accepts the Services ID; the secret is made for each', async () => {
  setup();
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: URLSearchParams }) => { seen.push(init.body.get('client_id')!); return { ok: init.body.get('client_id') === SERVICES_ID }; }));
  expect(await revokeAppleToken('r-web')).toBe(true);
  expect(seen).toEqual([APPLE_ID, SERVICES_ID]);
  seen.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: URLSearchParams }) => { seen.push(init.body.get('client_id')!); return { ok: true }; }));
  expect(await revokeAppleToken('r-ios')).toBe(true);
  expect(seen).toEqual([APPLE_ID]);
  const secret = await jwtVerify(await appleClientSecret(1_800_000_000, SERVICES_ID), ec.publicKey, { currentDate: new Date(1_800_000_100 * 1000) });
  expect(secret.payload.sub).toBe(SERVICES_ID);
});
