import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isStateUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { getState } from '../store/getState.js';

// The `state` section is a read (docs/data/sync.md): what the user has, what is on sale and the ad rules, in `down.state`; the catalogue and the ad rules come back whole only when the version in the request is not the current one.
export const applyState = async (_app: FastifyInstance, _ctx: SyncContext, up: unknown): Promise<SectionResult> => (isStateUp(up) ? { ok: true } : { ok: false, code: ErrorCode.BAD_REQUEST });

export async function readState(app: FastifyInstance, { userid }: SyncContext, up: unknown): Promise<{ down: unknown } | undefined> {
  return isStateUp(up) ? { down: await getState(app, userid, up) } : undefined;
}
