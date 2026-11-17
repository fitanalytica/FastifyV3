import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { emailConfigured, sendEmail } from '../email/sendEmail.js';

// docs/data/api.md section 8b. Deleting an account is confirmed with a 6-digit code sent to the account's e-mail address (the one the sign-in gave, kept in
// `userlogin.email`, never one the app says). Only a keyed hash of the code is stored; it lives 10 minutes, dies after 5 wrong tries, may be sent again after
// 30 seconds and at most 5 times an hour.

const TTL_S = 600;
const MAX_ATTEMPTS = 5;
const RESEND_WAIT_S = 30;
const MAX_SENDS_PER_HOUR = 5;

const now = () => Math.floor(Date.now() / 1000);
const hash = (userid: string, code: string) => createHmac('sha256', env().jwtSecret).update(`delete-account:${userid}:${code}`).digest('hex');

/** Makes a code, keeps its hash and e-mails the code. 400 when the account has no e-mail, 429 when asked too often, 503 when the mail cannot go. */
export async function sendDeletionCode(app: FastifyInstance, userid: string): Promise<{ expiresIn: number; resendIn: number }> {
  const w = app.pg.writer;
  const user = (await w.query('SELECT email FROM userlogin WHERE userid = $1', [userid])).rows[0];
  if (!user?.email) throw errors.BadRequest('This account has no e-mail address to send a code to', ErrorCode.BAD_REQUEST);
  if (!emailConfigured() && !env().devLogin) throw errors.Unavailable('E-mail is not set up on the server', ErrorCode.EMAIL_UNAVAILABLE);
  const t = now();
  const prev = (await w.query('SELECT sent_at, sends, sends_from FROM account_deletion_codes WHERE userid = $1', [userid])).rows[0];
  if (prev && t - prev.sent_at < RESEND_WAIT_S) throw errors.TooManyRequests('Wait a moment before asking for another code', ErrorCode.BAD_REQUEST);
  const sameHour = prev && t - prev.sends_from < 3600;
  if (sameHour && prev.sends >= MAX_SENDS_PER_HOUR) throw errors.TooManyRequests('Too many codes were asked for: try again later', ErrorCode.BAD_REQUEST);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await w.query(
    `INSERT INTO account_deletion_codes (userid, code_hash, expires_at, attempts, sent_at, sends, sends_from) VALUES ($1, $2, $3, 0, $4, $5, $6)
     ON CONFLICT (userid) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at,
       sends = EXCLUDED.sends, sends_from = EXCLUDED.sends_from`,
    [userid, hash(userid, code), t + TTL_S, t, sameHour ? prev.sends + 1 : 1, sameHour ? prev.sends_from : t],
  );
  if (emailConfigured()) {
    await sendEmail({
      to: user.email,
      subject: 'Confirm deleting your fitAnalytica account',
      body: `Your confirmation code is ${code}.\n\nEnter it in the app to delete your fitAnalytica account and everything in it. It works for 10 minutes. If you did not ask for this, you can ignore this e-mail: nothing is deleted without the code.\n\nfitAnalytica`,
    });
  } else {
    // Local testing only (DEV_LOGIN=true, no topic): the code goes to the server's log instead of an inbox.
    app.log.warn({ userid, code }, 'account deletion code (not e-mailed: SNS_ARN is not set)');
  }
  return { expiresIn: TTL_S, resendIn: RESEND_WAIT_S };
}

/**
 * Checks the code. `consume` removes it (the deletion itself); without it the code stays valid (the app checks it first, then asks for the deletion with it).
 * A wrong code counts a try; after 5 the code is dead and a new one must be asked for. 400 `DELETE_CODE_WRONG` for anything wrong with it.
 */
export async function checkDeletionCode(app: FastifyInstance, userid: string, code: string, consume = false): Promise<void> {
  const w = app.pg.writer;
  const row = (await w.query('SELECT code_hash, expires_at, attempts FROM account_deletion_codes WHERE userid = $1', [userid])).rows[0];
  if (!row || row.expires_at < now() || row.attempts >= MAX_ATTEMPTS) throw errors.BadRequest('Ask for a new code', ErrorCode.DELETE_CODE_WRONG);
  const given = Buffer.from(hash(userid, code));
  const known = Buffer.from(String(row.code_hash).trim());
  if (given.length !== known.length || !timingSafeEqual(given, known)) {
    await w.query('UPDATE account_deletion_codes SET attempts = attempts + 1 WHERE userid = $1', [userid]);
    throw errors.BadRequest('That code is wrong', ErrorCode.DELETE_CODE_WRONG);
  }
  if (consume) await w.query('DELETE FROM account_deletion_codes WHERE userid = $1', [userid]);
}
