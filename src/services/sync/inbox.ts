import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isInboxUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { ackActivities, inboxActivities } from '../activities/inbox.js';
import { codeOf } from './codeOf.js';

/** How many watch activities one pull returns (the rest is `more`). */
export const INBOX_PULL = 20;

// The `inbox` section of the unified call (docs/data/sync.md): the watch's activities waiting for the phone. `ack` leaves the inbox (answered `ack`: the ids that were waiting), `pull` reads the next ones.
export async function applyInbox(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<SectionResult> {
  if (!isInboxUp(up)) return { ok: false, code: ErrorCode.BAD_REQUEST };
  if (!up.ack) return { ok: true };
  try {
    return { ok: true, ack: (await ackActivities(app, userid, up.ack)).acked };
  } catch (e) {
    return { ok: false, code: codeOf(app, e) };
  }
}

/** The next activities waiting, oldest first: `{ activities }` in `down.inbox`; `more` when there are more than one pull gives. Read after the acks of the same call. */
export async function readInbox(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<{ down: unknown; more: boolean } | undefined> {
  if (!isInboxUp(up) || !up.pull) return undefined;
  // One more than a pull gives, to know whether there is more; the text is the database's, parsed once to embed it in the answer.
  const body = JSON.parse(await inboxActivities(app, userid, INBOX_PULL + 1)) as { activities: unknown[] };
  const more = body.activities.length > INBOX_PULL;
  return { down: { activities: body.activities.slice(0, INBOX_PULL) }, more };
}
