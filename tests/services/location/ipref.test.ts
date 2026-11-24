import { expect, test } from 'vitest';
import { IPREF_MAX_AGE_SECONDS, checkIpref, makeIpref } from '../../../src/services/location/ipref.js';

// The ipref (docs/data/server.md section 7): a time and a keyed hash of the address, never the address.
const KEY = 'test-key';
const NOW = 1_731_480_000;

test('it carries the time and a hash, and nothing that is the address', () => {
  const ipref = makeIpref('203.0.113.9', NOW, KEY);
  expect(ipref).toMatch(new RegExp(`^${NOW}\\.[0-9a-f]{32}$`));
  expect(ipref).not.toContain('203');
  expect(makeIpref('203.0.113.9', NOW, KEY)).toBe(ipref);
  expect(makeIpref('203.0.113.10', NOW, KEY)).not.toBe(ipref);
  expect(makeIpref('203.0.113.9', NOW, 'other-key')).not.toBe(ipref);
});

test('the same address: same; an IPv4-mapped form of it is the same address', () => {
  const ipref = makeIpref('203.0.113.9', NOW - 10, KEY);
  expect(checkIpref('203.0.113.9', ipref, NOW, KEY)).toBe('same');
  expect(checkIpref('::ffff:203.0.113.9', ipref, NOW, KEY)).toBe('same');
});

test('a different address: ignored within two hours, looked up after two hours', () => {
  const ipref = makeIpref('203.0.113.9', NOW - 3600, KEY);
  expect(IPREF_MAX_AGE_SECONDS).toBe(2 * 3600);
  expect(checkIpref('198.51.100.7', ipref, NOW, KEY)).toBe('ignore');
  const old = makeIpref('203.0.113.9', NOW - IPREF_MAX_AGE_SECONDS, KEY);
  expect(checkIpref('198.51.100.7', old, NOW, KEY)).toBe('changed');
});

test('none, or one that is not an ipref (or made with another key): look up', () => {
  for (const bad of [undefined, '', 'abc', '123.zz', `${NOW}.${'0'.repeat(32)}x`]) expect(checkIpref('203.0.113.9', bad, NOW, KEY), String(bad)).toBe('changed');
  const foreign = makeIpref('203.0.113.9', NOW - 10, 'someone-else');
  expect(checkIpref('203.0.113.9', foreign, NOW, KEY)).toBe('ignore');
});
