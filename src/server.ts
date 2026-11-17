import { build } from './app.js';
import { env } from './config/env.js';

const app = await build();
await app.listen({ port: env().port, host: '0.0.0.0' });
