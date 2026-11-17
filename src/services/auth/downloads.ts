import type { FastifyInstance } from 'fastify';

/** The `downloads.platform` of a device: a watch is watchos (Apple) or wearos (Android). */
const platformFor = (android: boolean, watch: boolean) => (watch ? (android ? 'wearos' : 'watchos') : android ? 'android' : 'ios');

/** Makes (or takes over) the install's `downloads` row for the user. A repeat changes nothing but the owner. */
export async function registerDownload(app: FastifyInstance, d: { downloadid: string; userid: string; platform?: string; watch?: boolean }): Promise<void> {
  await app.pg.writer.query(
    `INSERT INTO downloads (downloadid, userid, device_type, platform)
     VALUES ($1, $2, $3, $4) ON CONFLICT (downloadid) DO UPDATE SET userid = EXCLUDED.userid`,
    [d.downloadid, d.userid, d.watch ? 'watch' : 'phone', platformFor(d.platform === 'android', Boolean(d.watch))],
  );
}
