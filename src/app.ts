import Fastify from 'fastify';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './errors/handler.js';
import { registerPlugins } from './plugins/index.js';
import routes from './routes/index.js';

/** Builds the app without listening, so tests can call it with `app.inject`. */
export async function build() {
  const { trustProxy } = env(); // a missing variable stops the start here, with its name
  const app = Fastify({
    logger: true,
    // Where the client's address comes from (the IP lookup reads it): the socket's, or X-Forwarded-For behind a load balancer.
    // (a number is the count of proxies to trust: Fastify takes it, its types only list a boolean)
    trustProxy: trustProxy as boolean,
    bodyLimit: 15 * 1024 * 1024,
    // Fastify's default is coerceTypes: 'array', which wraps a lone value in a list (activities: 'x' would become ['x']).
    // `true` still turns a query string into a number (limit=20) and nothing more.
    ajv: { customOptions: { coerceTypes: true } },
  });
  // Handlers first: plugins and routes registered later inherit them.
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  await registerPlugins(app);
  await app.register(routes);
  return app;
}
