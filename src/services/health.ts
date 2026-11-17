import type { FastifyInstance } from 'fastify';

/** True when the reader pool answers. */
export async function databaseIsUp(app: FastifyInstance): Promise<boolean> {
  const r = await app.pg.reader.query('SELECT 1 AS ok');
  return r.rows[0].ok === 1;
}
