import type { FastifyRequest } from 'fastify';
import { getWeather } from '../../../services/weather/getWeather.js';
import type { WeatherBody } from '../../../types/index.js';

/** POST /phone/v3/weather: the conditions now at a point (docs/data/api.md section 13). */
export const weatherV3 = async (req: FastifyRequest) => {
  const { lat, lon } = req.body as WeatherBody;
  return getWeather(lat, lon);
};
