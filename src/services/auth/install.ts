import type { FastifyInstance } from 'fastify';
import type { InstallBody } from '../../types/index.js';
import { registerDownload, type InstallPlace } from './downloads.js';

/** What the install is answered with, at once, as its first payload: its id, and where it is (the place of its IP address). */
export interface InstallReply {
  downloadid: string;
  place: InstallPlace | null;
}

/**
 * The install's first call (docs/data/api.md section 1d), made when the app is first opened and **before anyone signs in**: its `downloads` row is made with its download id, its device id, what
 * it says about itself and the place of its IP address, and that place comes straight back as the first payload. A repeat only brings the row up to date; the place is found once.
 */
export async function install(app: FastifyInstance, b: InstallBody, ip: string, watch: boolean): Promise<InstallReply> {
  const place = await registerDownload(app, { downloadid: b.downloadid, deviceid: b.deviceid, platform: b.platform, watch, info: b.deviceInfo, ip });
  return { downloadid: b.downloadid, place };
}
