import { test, expect } from 'vitest';
import { build } from '../helpers/app.js';
import { probe } from '../helpers/viaSync.js';

test('a client error is logged to apperrors and the reply carries the errorid', async () => {
  const app = await build();
  const res = await app.inject({ method: 'POST', url: '/phone/v3/auth/refresh', payload: {} });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('refreshToken') });
  const id = res.json().errorId;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  const row = await app.pg.writer.query('SELECT code, method, status_code FROM apperrors WHERE errorid = $1', [id]);
  expect(row.rows[0]).toEqual({ code: 'BAD_REQUEST', method: 'POST', status_code: 400 });
  await app.pg.writer.query('DELETE FROM apperrors WHERE errorid = $1', [id]);
  await app.close();
});

test('routine codes (TOKEN_EXPIRED, LOGOUT, NOT_FOUND) are not logged', async () => {
  const app = await build();
  const before = await app.pg.writer.query('SELECT count(*)::int n FROM apperrors');
  const res = await probe(app, 'a.b.c');
  expect(res.json()).toMatchObject({ code: 'LOGOUT', errorId: '' });
  const after = await app.pg.writer.query('SELECT count(*)::int n FROM apperrors');
  expect(after.rows[0].n).toBe(before.rows[0].n);
  await app.close();
});
