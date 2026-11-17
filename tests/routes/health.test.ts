import { test, expect } from 'vitest';
import { build } from '../helpers/app.js';

test('health reads the reader pool; an unknown route is NOT_FOUND', async () => {
  const app = await build();
  expect((await app.inject({ url: '/health' })).json()).toEqual({ ok: true });
  const nf = await app.inject({ url: '/nope' });
  expect(nf.statusCode).toBe(404);
  expect(nf.json().code).toBe('NOT_FOUND');
  await app.close();
});
