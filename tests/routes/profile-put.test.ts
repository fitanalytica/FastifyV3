import { test, expect, beforeAll, afterAll } from 'vitest';
import { build, createAccount, type Account, type TestApp } from '../helpers/app.js';
import { bearer } from '../helpers/fixtures.js';

// Edit profile (docs/data/api.md section 7): the first call makes the row, later calls change only what they carry.
let app: TestApp;
let a: Account;

const put = (body: unknown, token = a.phoneToken) => app.inject({ method: 'PUT', url: '/phone/v3/profile', headers: bearer(token), payload: body as object });
const row = async () => (await app.pg.writer.query('SELECT * FROM userinfo WHERE userid = $1', [a.userid])).rows[0];

beforeAll(async () => {
  app = await build();
  a = await createAccount(app);
});
afterAll(async () => {
  await a.remove();
  await app.pg.writer.query('DELETE FROM userinfo WHERE userid = $1', [a.userid]);
  await app.close();
});

test('the first call makes the profile (and the profile route reads it back); nothing else is touched', async () => {
  expect((await app.inject({ url: '/phone/v3/profile', headers: bearer(a.phoneToken) })).statusCode).toBe(404);
  const res = await put({ fname: 'Asha', lname: 'Rao', gender: 'other', dobglobal: 252460800, height: 172.5, weight: 61.2, about: 'Runs at dawn' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ fname: 'Asha', lname: 'Rao', gender: 'other', dobglobal: 252460800, about: 'Runs at dawn' });
  const r = await row();
  expect(r).toMatchObject({ fname: 'Asha', lname: 'Rao', gender: 'other', dobglobal: 252460800, about: 'Runs at dawn', hideprofile: false });
  expect(r.dateregistered).toBeGreaterThan(1_700_000_000);
  expect((await app.inject({ url: '/phone/v3/profile', headers: bearer(a.phoneToken) })).statusCode).toBe(200);
});

test('a later call changes only the fields it carries, and keeps the registration date and visibility', async () => {
  const before = await row();
  await app.inject({ method: 'PUT', url: '/phone/v3/profile/visibility', headers: bearer(a.phoneToken), payload: { hidden: true } });
  expect((await put({ weight: 70 })).statusCode).toBe(200);
  const r = await row();
  expect(r).toMatchObject({ fname: 'Asha', lname: 'Rao', gender: 'other', about: 'Runs at dawn', hideprofile: true });
  expect(r.weight).toBeCloseTo(70);
  expect(r.dateregistered).toBe(before.dateregistered);
});

test('null clears a field, an empty text too, and the surname can be cleared but not the given name', async () => {
  expect((await put({ about: null, lname: '   ', gender: null, dobglobal: null })).statusCode).toBe(200);
  expect(await row()).toMatchObject({ about: null, lname: null, gender: null, dobglobal: null });
  expect((await put({ fname: null })).statusCode).toBe(400);
  expect((await put({ fname: '' })).statusCode).toBe(400);
});

test('a name is trimmed; a repeat changes nothing', async () => {
  await put({ fname: '  Asha  ' });
  expect((await row()).fname).toBe('Asha');
  expect((await put({ fname: 'Asha' })).statusCode).toBe(200);
  expect((await row()).fname).toBe('Asha');
});

test('an unknown field is ignored (visibility has its own route); nothing to change or a value out of range is refused', async () => {
  expect((await put({ fname: 'Asha', hideprofile: true })).statusCode).toBe(200);
  expect((await row()).hideprofile).toBe(true); // was set above by the visibility call, and not touched here
  await app.inject({ method: 'PUT', url: '/phone/v3/profile/visibility', headers: bearer(a.phoneToken), payload: { hidden: false } });
  await put({ fname: 'Asha', hideprofile: true });
  expect((await row()).hideprofile).toBe(false);
  expect((await put({})).statusCode).toBe(400);
  expect((await put({ gender: 'x' })).statusCode).toBe(400);
  expect((await put({ height: 5 })).statusCode).toBe(400);
  expect((await put({ weight: 900 })).statusCode).toBe(400);
  expect((await put({ about: 'a'.repeat(501) })).statusCode).toBe(400);
});
