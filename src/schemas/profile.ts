import { Type } from '@sinclair/typebox';

/**
 * PUT /phone/v3/profile/location: where the phone is, from its GPS, exact and not rounded (docs/data/api.md section 7). The city, state and
 * country code come from the phone's own reverse lookup. The country's name is not sent: the server looks it up from the code.
 */
export const LocationBodySchema = Type.Object({
  lat: Type.Number({ minimum: -90, maximum: 90 }),
  lon: Type.Number({ minimum: -180, maximum: 180 }),
  city: Type.String({ minLength: 1, maxLength: 100 }),
  /** Some places have none (Singapore): leave it out or send it empty. */
  state: Type.Optional(Type.String({ maxLength: 100 })),
  /** ISO 3166-1 alpha-2, any case. */
  iso: Type.String({ minLength: 2, maxLength: 2 }),
});

/** POST /phone/v3/profile/image/presign (docs/data/api.md section 7b): `pic` is the profile picture, `bg` the cover. */
const Kind = Type.Union([Type.Literal('pic'), Type.Literal('bg')]);
export const ProfilePresignBodySchema = Type.Object({
  kind: Kind,
  contentType: Type.String({ maxLength: 50 }),
  bytes: Type.Integer({ minimum: 1, maximum: 20 * 1024 * 1024 }),
});
export const ProfileCommitBodySchema = Type.Object({ kind: Kind, value: Type.String({ pattern: '^[0-9a-fA-F-]{36}\\.(webp|jpg)$' }) });
export const ProfileKindParamsSchema = Type.Object({ kind: Kind });
/** GET /phone/v3/profilepic/:userid/:value and /profilebg/:userid/:value. */
export const ProfileImageParamsSchema = Type.Object({ userid: Type.String({ format: 'uuid' }), value: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' }) });
