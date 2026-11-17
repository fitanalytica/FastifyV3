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
