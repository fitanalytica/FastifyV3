import type { FastifyRequest } from 'fastify';
import { updateLocation } from '../../../services/profile/updateLocation.js';
import type { LocationBody, LocationResponse } from '../../../types/index.js';

/** PUT /phone/v3/profile/location { lat, lon, city, state, iso }. The place as saved, with the country's name. */
export const profileLocationV3 = (req: FastifyRequest): Promise<LocationResponse> =>
  updateLocation(req.server, req.userid!, req.body as LocationBody);
