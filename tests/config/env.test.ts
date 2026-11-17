import { test, expect, beforeEach, afterEach } from 'vitest';
import { env } from '../../src/config/env.js';
import { build } from '../../src/app.js';

const KEYS = ['JWE_SECRET', 'PG_WRITER_URL', 'PG_READER_URL', 'PORT', 'JWT_EXPIRY', 'PG_SSL', 'DEV_LOGIN', 'DEV_USER_APPLE', 'DEV_USER_GOOGLE'];
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); });
afterEach(() => { for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); });

test('the local settings are read and typed', () => {
  const e = env();
  expect(e.port).toBe(3003);
  expect(e.jwtExpiry).toBe('7d');
  expect(e.pgSsl).toBe(false);
  expect(typeof e.jwtSecret).toBe('string');
});

test('a missing variable is named in the error, and build() stops with it', async () => {
  delete process.env.JWE_SECRET; delete process.env.PG_WRITER_URL;
  expect(() => env()).toThrow('Missing environment variables: JWE_SECRET, PG_WRITER_URL');
  await expect(build()).rejects.toThrow(/JWE_SECRET/);
});

test('defaults, and a bad PORT is refused', () => {
  delete process.env.PORT; delete process.env.JWT_EXPIRY;
  expect(env().port).toBe(3003);
  expect(env().jwtExpiry).toBe('7d');
  process.env.PORT = 'abc';
  expect(() => env()).toThrow(/PORT/);
  process.env.PORT = '70000';
  expect(() => env()).toThrow(/PORT/);
});

test('flags are read each time', () => {
  process.env.DEV_LOGIN = 'true'; expect(env().devLogin).toBe(true);
  process.env.DEV_LOGIN = 'false'; expect(env().devLogin).toBe(false);
  delete process.env.DEV_LOGIN; expect(env().devLogin).toBe(false);
  process.env.PG_SSL = 'true'; expect(env().pgSsl).toBe(true);
});

test('dev users per provider: a userid, lower-cased, or nothing; anything else is refused', () => {
  delete process.env.DEV_USER_APPLE; delete process.env.DEV_USER_GOOGLE;
  expect(env().devUsers).toEqual({ apple: undefined, google: undefined });
  process.env.DEV_USER_APPLE = 'E0779E72-F607-44E2-88DE-5F164BB6E1DA';
  expect(env().devUsers.apple).toBe('e0779e72-f607-44e2-88de-5f164bb6e1da');
  process.env.DEV_USER_GOOGLE = 'not-a-uuid';
  expect(() => env()).toThrow(/DEV_USER_GOOGLE/);
});
