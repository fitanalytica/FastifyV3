import { test, expect, beforeEach } from 'vitest';
import { exchangeRate, setExchangeFetcher } from '../../../src/services/store/exchangeRate.js';

// docs/data/api.md section 15: the rate stored with a payment, as the old app did, without ever holding a purchase up.
let calls = 0;
beforeEach(() => {
  calls = 0;
  setExchangeFetcher(async () => { calls++; return { inr: 83.1234, eur: 0.9249, bad: Number.NaN }; });
});

test('units per dollar, 2 decimals; any case; 1 for dollars, for no currency and for one not on the list', async () => {
  expect(await exchangeRate('INR')).toBe(83.12);
  expect(await exchangeRate('eur')).toBe(0.92);
  expect(await exchangeRate('USD')).toBe(1);
  expect(await exchangeRate(undefined)).toBe(1);
  expect(await exchangeRate('XYZ')).toBe(1);
  expect(await exchangeRate('bad')).toBe(1);
});

test('the list is fetched once and kept for 6 hours', async () => {
  const t0 = 1_000_000;
  await exchangeRate('INR', t0);
  await exchangeRate('EUR', t0 + 5 * 3600 * 1000);
  expect(calls).toBe(1);
  await exchangeRate('EUR', t0 + 6 * 3600 * 1000);
  expect(calls).toBe(2);
});

test('when it cannot be fetched the answer is 1, and it is not tried again for 5 minutes', async () => {
  let n = 0;
  setExchangeFetcher(async () => { n++; throw new Error('down'); });
  const t0 = 5_000_000;
  expect(await exchangeRate('INR', t0)).toBe(1);
  expect(await exchangeRate('INR', t0 + 60_000)).toBe(1);
  expect(n).toBe(1);
  expect(await exchangeRate('INR', t0 + 5 * 60_000)).toBe(1);
  expect(n).toBe(2);
  setExchangeFetcher(async () => ({ inr: 80 }));
  expect(await exchangeRate('INR', t0 + 6 * 60_000)).toBe(80);
});
