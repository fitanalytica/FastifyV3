import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AuthInfo, Kind } from './auth.js';

type Authenticate = (req: FastifyRequest) => Promise<void>;

// Adds our own fields to Fastify's types. Nothing runs here.
declare module 'fastify' {
  interface FastifyInstance {
    pg: { reader: Pool; writer: Pool };
    /** `authenticate('phone')` checks the token of a phone route (refuses a watch token); `'watch'` the reverse. See hooks/authenticate.ts. */
    authenticate: (kind: Kind) => Authenticate;
  }
  interface FastifyRequest {
    auth?: AuthInfo;
    userid?: string;
  }
}
