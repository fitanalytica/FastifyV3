import type { FastifyInstance } from 'fastify';
import { ErrorCode } from '../../errors/codes.js';
import { isProfileUp, type SectionResult, type SyncContext } from '../../types/index.js';
import { putProfile } from '../profile/putProfile.js';
import { setVisibility } from '../profile/setVisibility.js';
import { updateLocation } from '../profile/updateLocation.js';
import { codeOf } from './codeOf.js';

// The `profile` section of the unified call (docs/data/sync.md): `put` is `PUT /profile` (the fields as saved come back in `put`; the first one makes the profile) and `visibility` is `PUT /profile/visibility`
// (`visibility`: `{ hidden }`; `NOT_FOUND` until the profile exists, so the phone sends it again after) and `location` is `PUT /profile/location` (the place as saved, with the country's name; `NOT_FOUND` until the
// profile exists). They are tried in that order and fail alone.
export async function applyProfile(app: FastifyInstance, { userid, ip }: SyncContext, up: unknown): Promise<SectionResult> {
  if (!isProfileUp(up)) return { ok: false, code: ErrorCode.BAD_REQUEST };
  const result: SectionResult = { ok: true };
  if (up.put) {
    try {
      result.put = await putProfile(app, userid, up.put, ip);
    } catch (e) {
      result.ok = false;
      result.code = codeOf(app, e);
      result.put = result.code;
    }
  }
  if (up.visibility) {
    try {
      result.visibility = await setVisibility(app, userid, up.visibility.hidden);
    } catch (e) {
      result.ok = false;
      result.code = codeOf(app, e);
      result.visibility = codeOf(app, e);
    }
  }
  if (up.location) {
    try {
      result.location = await updateLocation(app, userid, up.location);
    } catch (e) {
      result.ok = false;
      result.code = codeOf(app, e);
      result.location = codeOf(app, e);
    }
  }
  return result;
}
