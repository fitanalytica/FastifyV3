import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isStreakConfigUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { streakConfig } from '../streak/streakConfig.js';

// The `streakConfig` section is a read (docs/data/sync.md section 4f): the levels and the notification texts, in `down.streakConfig`. The phone sends the version it holds; the content comes back whole only when it is not the current one.
export const applyStreakConfig = async (_app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<SectionResult> => (isStreakConfigUp(up) ? { ok: true } : { ok: false, code: ErrorCode.BAD_REQUEST });

export async function readStreakConfig(_app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<{ down: unknown } | undefined> {
  if (!isStreakConfigUp(up)) {
    return undefined;
  }
  const config = streakConfig();
  return { down: up.version === config.version ? { version: config.version } : config };
}
