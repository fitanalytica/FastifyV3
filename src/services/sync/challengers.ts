import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isChallengersUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { countryName } from '../location/countries.js';
import { dummyChallengers } from '../rank/dummyChallengers.js';

// The `challengers` section is a read (docs/data/sync.md section 4c): the step challengers of today, in `down.challengers`, asked for in the same call as everything else.
export const applyChallengers = async (_app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<SectionResult> => (isChallengersUp(up) ? { ok: true } : { ok: false, code: ErrorCode.BAD_REQUEST });

export async function readChallengers(app: FastifyInstance, ctx: SyncContext, up: unknown): Promise<{ down: unknown } | undefined> {
  if (!isChallengersUp(up)) {
    return undefined;
  }
  // The user's own country (the card shows it under their name), from their profile; none when they have not set one.
  const r = await app.pg.reader.query<{ iso: string | null }>('SELECT iso FROM userinfo WHERE userid = $1', [ctx.userid]);
  const iso = r.rows[0]?.iso ?? '';
  return { down: dummyChallengers(up.steps ?? 0, countryName(iso) ?? '', iso.toUpperCase()) };
}
