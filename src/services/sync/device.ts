import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isDeviceUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { updateDevice } from '../auth/downloads.js';
import { codeOf } from './codeOf.js';

// The `device` section of the unified call (docs/data/sync.md): what changed about this phone, as `PUT /device` (docs/data/api.md section 1d). Applied to the install the token belongs to.
export async function applyDevice(app: FastifyInstance, { userid, auth, ip }: SyncContext, up: unknown): Promise<SectionResult> {
  if (!isDeviceUp(up)) return { ok: false, code: ErrorCode.BAD_REQUEST };
  try {
    await updateDevice(app, userid, auth.downloadid, up, ip);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: codeOf(app, e) };
  }
}
