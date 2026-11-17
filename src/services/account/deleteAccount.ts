import type { FastifyInstance } from 'fastify';
import { errors } from '../../errors/AppError.js';
import { ErrorCode } from '../../errors/codes.js';
import { revokeAppleToken } from '../auth/providers/apple.js';
import { isOurFile } from '../media/profileImage.js';
import { knownTokens } from '../auth/tokenUtils.js';
import { deleteFolder, deleteObjects } from '../media/s3Ops.js';
import { checkDeletionCode } from './deletionCode.js';

// docs/data/api.md section 8b and server.md section 8. Deleting an account, confirmed by the e-mailed code. In this order, so that a failure leaves nothing half
// done that cannot be repeated:
//   1. the user is marked deleted (`userinfo.deleted_date`) and hidden from everyone else. Their tokens still work, so the same request can be repeated;
//   2. every file in S3 goes: the folder of every activity and every post, and the picture and cover. If S3 does not answer the request FAILS (502) and nothing
//      else is deleted: repeated, it carries on (the code stays valid until its time is up). No file is ever left without its owner;
//   3. Apple is told to revoke the Sign in with Apple grant of every device (a failure is logged and never stops the deletion);
//   4. the rows, in ONE transaction: the user's login (which takes the activities, posts, tokens, steps... with it, so every device is signed out), the install
//      rows, and the profile row. The profile row (`userinfo`) is KEPT for a user who has bought a subscription (billing needs it), without the pictures and hidden.

const FOLDERS_AT_ONCE = 16;
const HAS_PAYMENTS = `SELECT to_regclass('public.paymentstore') IS NOT NULL AS table_exists`;
const PAID = 'SELECT 1 FROM paymentstore WHERE userid = $1 LIMIT 1';

/** Whether the user has bought anything: their profile row is kept for billing. The billing tables are not part of v3 (the old app's `paymentstore`). */
export async function hasPurchase(app: FastifyInstance, userid: string): Promise<boolean> {
  const w = app.pg.writer;
  if (!(await w.query(HAS_PAYMENTS)).rows[0].table_exists) return false;
  return (await w.query(PAID, [userid])).rowCount! > 0;
}

/** Runs `work` on each item, `limit` at a time. Rejects at the first failure (what is running finishes). */
async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (next < items.length && failed === undefined) {
      const item = items[next++];
      try {
        await work(item);
      } catch (e) {
        failed = e ?? new Error('failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== undefined) throw failed;
}

export interface Deleted {
  /** How many Apple grants were revoked, and how many could not be. */
  apple: { revoked: number; failed: number };
  /** The profile row was kept (a subscription). */
  kept: boolean;
}

export async function deleteAccount(app: FastifyInstance, userid: string, code: string): Promise<Deleted> {
  await checkDeletionCode(app, userid, code);
  const w = app.pg.writer;

  // 1. Hidden from others.
  await w.query('UPDATE userinfo SET deleted_date = coalesce(deleted_date, EXTRACT(EPOCH FROM now())::int), hideprofile = true WHERE userid = $1', [userid]);

  // 2. Files.
  const ids = [
    ...(await w.query('SELECT activityid AS id FROM activities WHERE userid = $1', [userid])).rows,
    ...(await w.query('SELECT postid AS id FROM posts WHERE userid = $1', [userid])).rows,
  ].map((r) => r.id as string);
  const images = (await w.query('SELECT profilepic, profilebg FROM userinfo WHERE userid = $1', [userid])).rows[0];
  try {
    await inParallel(ids, FOLDERS_AT_ONCE, (id) => deleteFolder(id));
    const files = [images?.profilepic, images?.profilebg].filter(isOurFile);
    if (files.length) await deleteObjects(files, 'profile');
  } catch (e) {
    app.log.error({ err: e, userid }, 'account deletion: files could not be deleted from S3');
    throw errors.BadGateway('Your files could not be deleted right now. Nothing else was deleted: try again.', ErrorCode.DELETE_FAILED);
  }

  // 3. Apple.
  const tokens = (await w.query('SELECT DISTINCT apple_refresh_token AS t FROM usertokens WHERE userid = $1 AND apple_refresh_token IS NOT NULL', [userid])).rows.map((r) => r.t as string);
  const results = await Promise.all(tokens.map((t) => revokeAppleToken(t)));
  const apple = { revoked: results.filter(Boolean).length, failed: results.filter((ok) => !ok).length };
  if (apple.failed) app.log.error({ userid, failed: apple.failed }, 'Apple grants not revoked on account deletion (retry by hand)');

  // 4. Rows, together or not at all.
  const kept = await hasPurchase(app, userid);
  const accessTokens = (await w.query('SELECT access_token FROM usertokens WHERE userid = $1', [userid])).rows.map((r) => String(r.access_token).trim());
  const c = await w.connect();
  try {
    await c.query('BEGIN');
    // The old app's `quotations` points at the login with no delete action, so it would stop the delete (it is not part of v3: only where it exists).
    if ((await c.query("SELECT to_regclass('public.quotations') IS NOT NULL AS t")).rows[0].t) await c.query('DELETE FROM quotations WHERE userid = $1', [userid]);
    await c.query('DELETE FROM userlogin WHERE userid = $1', [userid]);
    // An install's row is shared by whoever signed in on that phone (`downloadid` is the install, not the user): another account's activities may still point at it,
    // and a row that is still pointed at is left (it holds a device and an app version, nothing about the user). One at a time, so one that stays does not stop the rest.
    for (const d of (await c.query('SELECT downloadid FROM downloads WHERE userid = $1', [userid])).rows) {
      await c.query('SAVEPOINT download');
      try {
        await c.query('DELETE FROM downloads WHERE downloadid = $1', [d.downloadid]);
        await c.query('RELEASE SAVEPOINT download');
      } catch (e) {
        if ((e as { code?: string }).code !== '23503') throw e;
        await c.query('ROLLBACK TO SAVEPOINT download');
      }
    }
    if (kept) await c.query('UPDATE userinfo SET profilepic = NULL, profilebg = NULL, hideprofile = true WHERE userid = $1', [userid]);
    else await c.query('DELETE FROM userinfo WHERE userid = $1', [userid]);
    await c.query('COMMIT');
    // The server remembers a token it has checked for a while: forget this user's, so every device is out at once.
    for (const t of accessTokens) knownTokens.delete(t);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    app.log.error({ err: e, userid }, 'account deletion: the rows could not be deleted');
    // What went wrong is kept in the error log (`apperrors.value`), not in the answer.
    throw errors.Internal('The account could not be deleted', ErrorCode.DELETE_FAILED, { pg: (e as { code?: string }).code, detail: (e as { detail?: string; message?: string }).detail ?? (e as Error).message });
  } finally {
    c.release();
  }
  return { apple, kept };
}
