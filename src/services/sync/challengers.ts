import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isChallengersUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { readChallengers as readBoard, writeTotals } from '../leaderboard/stepTotals.js';
import { codeOf } from './codeOf.js';

// The `challengers` section (docs/data/sync.md section 4c): today's steps are stored as the Day total (the same row the rank section writes), and the answer is today's first eight, in `down.challengers`.
export async function applyChallengers(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<SectionResult> {
  if (!isChallengersUp(up)) return { ok: false, code: ErrorCode.BAD_REQUEST };
  try {
    if (up.steps !== undefined && up.day !== undefined) {
      await writeTotals(app, userid, { Day: up.day, Week: 0, Month: 0, Year: 0 }, { Day: up.steps, Week: 0, Month: 0, Year: 0, 'All time': 0 });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, code: codeOf(app, e) };
  }
}

export async function readChallengers(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<{ down: unknown } | undefined> {
  if (!isChallengersUp(up) || up.day === undefined) return undefined;
  return { down: await readBoard(app, userid, up.day, up.steps ?? 0) };
}
