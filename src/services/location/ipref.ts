import { createHmac, timingSafeEqual } from 'node:crypto';

// docs/data/server.md section 7: how the server notices that a phone with location off has changed IP address without ever keeping an address. Every answer carries an `ipref`: the time
// of the last lookup and a keyed hash (HMAC) of the address and that time, `1731480000.9f2c…`. The phone sends it back as `X-Ipref`; the server hashes the current address with the time in it.

/** The IP address is looked up again, at most, this often (seconds), even when it has changed. */
export const IPREF_MAX_AGE_SECONDS = 24 * 3600;

export type IpChange = 'same' | 'changed' | 'ignore';

const clean = (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip);

const hash = (ip: string, at: number, key: string) => createHmac('sha256', key).update(`${clean(ip)}|${at}`).digest('hex').slice(0, 32);

/** The `ipref` for this address at this time (seconds). Only the keyed hash of the address is in it, never the address. */
export const makeIpref = (ip: string, at: number, key: string): string => `${at}.${hash(ip, at, key)}`;

/** What the `ipref` the phone sent says about the current address: the same address (`same`), a different one and the last lookup is old or there is none (`changed`: look up), or a different one within the day (`ignore`). */
export function checkIpref(ip: string, ipref: string | undefined, now: number, key: string): IpChange {
  const match = /^(\d{1,12})\.([0-9a-f]{32})$/.exec(ipref ?? '');
  if (!match) return 'changed';
  const at = Number(match[1]);
  const given = Buffer.from(match[2]);
  const expected = Buffer.from(hash(ip, at, key));
  if (given.length === expected.length && timingSafeEqual(given, expected)) return 'same';
  return now - at >= IPREF_MAX_AGE_SECONDS ? 'changed' : 'ignore';
}
