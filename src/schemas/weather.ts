import { Type } from '@sinclair/typebox';

/** POST /phone/v3/weather: the conditions at a point (docs/data/api.md section 13). */
export const WeatherBodySchema = Type.Object({
  lat: Type.Number({ minimum: -90, maximum: 90 }),
  lon: Type.Number({ minimum: -180, maximum: 180 }),
});
