import fp from 'fastify-plugin';
import pg from 'pg';
import { env } from '../config/env.js';
import '../types/index.js';

export default fp(async (app) => {
  const e = env();
  const ssl = e.pgSsl ? { rejectUnauthorized: false } : false;
  const reader = new pg.Pool({ connectionString: e.pgReaderUrl, ssl, max: 5 });
  const writer = new pg.Pool({ connectionString: e.pgWriterUrl, ssl, max: 5 });
  app.decorate('pg', { reader, writer });
  app.addHook('onClose', async () => { await Promise.all([reader.end(), writer.end()]); });
});
