import { env } from '../../config/env.js';

// docs/data/api.md section 15. The old app's `membership` table is shared with the v2 API, which keeps writing it, so what is in it is read as it is, and read in one place.
//
// `expires_date` is not in one unit: the iOS code stored milliseconds (and 9999999999999 for a lifetime), the Android code stored seconds (9999999999). Compared with the clock
// in seconds, a millisecond value never expires. EXPIRES_S turns both into seconds (anything above 1e11 is milliseconds: that is the year 5138 in seconds and 1973 in milliseconds),
// so "is it still valid" has one definition. What v3 writes itself is in seconds.
export const EXPIRES_S = `(CASE WHEN expires_date > 100000000000 THEN expires_date / 1000 ELSE expires_date END)`;

/** The value of a lifetime in seconds (what the Android code stored, and what 9999999999999 milliseconds comes to). */
export const LIFETIME_S = 9999999999;

/** The membership tables to read: the live table, the sandbox copy, or both (BILLING_ENV). A fixed list, never from the request. */
export const membershipTables = (): string[] => ({ production: ['membership'], sandbox: ['membership_sandbox'], both: ['membership', 'membership_sandbox'] })[env().billingEnv];

/** The same, as one query's `WITH m AS (...)` body. */
export const membershipSource = (): string => membershipTables().map((t) => `SELECT * FROM ${t}`).join(' UNION ALL ');
