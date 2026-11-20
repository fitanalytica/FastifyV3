import type { FastifyReply, FastifyRequest } from 'fastify';
import { applyIpLocation } from '../../../services/location/ipLocation.js';

/**
 * Runs after sign-in checks on every phone route. A phone that says `X-Location: off` has the IP address as its place: it is looked up when the address changes (`X-Ipref`, docs/data/server.md
 * section 7) and the answer carries the `ipref` to keep. With `on` (or no header: the watch, an older app) nothing happens: the phone's own GPS is the source.
 */
export async function ipLocationHookV3(req: FastifyRequest, reply: FastifyReply) {
  if (!req.userid || String(req.headers['x-location']).toLowerCase() !== 'off') return;
  const ipref = await applyIpLocation(req.server, req.userid, req.ip, req.headers['x-ipref']?.toString());
  if (ipref) reply.header('ipref', ipref);
}
