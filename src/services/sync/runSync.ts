import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import type { SectionResult, SyncBody, SyncContext, SyncReply } from '../../types/index.js';
import { applyActivities } from './activities.js';
import { codeOf } from './codeOf.js';
import { applyDevice } from './device.js';
import { applyInbox, readInbox } from './inbox.js';
import { applyProfile } from './profile.js';
import { readRestore } from './restore.js';
import { applyState, readState } from './state.js';
import { applyWalk } from './walk.js';

// The unified sync call (docs/data/sync.md). The sections of `up`, each its own piece of work: a section fails alone and says so in `results`; the others are saved and answered.
// A section has `apply` (what the phone sent: checked and saved, answered in `results`) and, if it gives something back, `read` (put in `down`, after the apply of the same section; `more` asks the phone to send again at once).
// To add a section: one file here with those functions, and one line below.
type Apply = (app: FastifyInstance, ctx: SyncContext, up: unknown) => Promise<SectionResult>;
type Read = (app: FastifyInstance, ctx: SyncContext, up: unknown) => Promise<{ down: unknown; more?: boolean } | undefined>;
const SECTIONS: Record<string, { apply: Apply; read?: Read }> = {
  walk: { apply: applyWalk },
  activities: { apply: applyActivities },
  inbox: { apply: applyInbox, read: readInbox },
  profile: { apply: applyProfile },
  device: { apply: applyDevice },
  state: { apply: applyState, read: readState },
};

export async function runSync(app: FastifyInstance, ctx: SyncContext, body: SyncBody): Promise<SyncReply> {
  const results: Record<string, SectionResult> = {};
  const down: Record<string, unknown> = {};
  let more = false;
  for (const [name, up] of Object.entries(body.up ?? {})) {
    const section = Object.hasOwn(SECTIONS, name) ? SECTIONS[name] : undefined;
    if (!section) {
      results[name] = { ok: false, code: ErrorCode.UNKNOWN_SECTION };
      continue;
    }
    try {
      results[name] = await section.apply(app, ctx, up);
    } catch (e) {
      results[name] = { ok: false, code: codeOf(app, e) };
      continue;
    }
    if (section.read && results[name].ok) {
      try {
        const read = await section.read(app, ctx, up);
        if (read) {
          down[name] = read.down;
          more ||= !!read.more;
        }
      } catch (e) {
        results[name] = { ok: false, code: codeOf(app, e) };
      }
    }
  }
  // The restore (docs/data/sync.md section 5): asked for in `restore`, answered in `results.restore` and `down.restore`, after the sections of the same call.
  if (body.restore !== undefined) {
    try {
      const restored = await readRestore(app, ctx, body.restore);
      results.restore = restored.result;
      if (restored.down) down.restore = restored.down;
      more ||= !!restored.more;
    } catch (e) {
      results.restore = { ok: false, code: codeOf(app, e) };
    }
  }
  return { results, down, more };
}
