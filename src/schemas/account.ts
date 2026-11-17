import { Type } from '@sinclair/typebox';

/** POST /phone/v3/account/delete-code/verify and DELETE /phone/v3/account: the 6-digit code that was e-mailed (docs/data/api.md section 8b). */
export const DeleteCodeBodySchema = Type.Object({ code: Type.String({ pattern: '^[0-9]{6}$' }) });
