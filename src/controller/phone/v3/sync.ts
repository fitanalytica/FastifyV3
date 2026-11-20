import type { FastifyRequest } from 'fastify';
import { runSync } from '../../../services/sync/runSync.js';
import type { SyncBody } from '../../../types/index.js';

/** POST /phone/v3/sync { up?, have?, restore? }. One request for everything that changed, one answer with a result for each section (docs/data/sync.md). */
export const syncV3 = (req: FastifyRequest) => runSync(req.server, { userid: req.userid!, auth: req.auth!, ip: req.ip }, req.body as SyncBody);
