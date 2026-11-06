// Vercel serverless entry point. `npm run build` compiles src/ to dist/ first;
// every request is rewritten here (see vercel.json) and handed to the Fastify app.
import { buildApp } from '../dist/app.js';

let ready;

export default async function handler(req, res) {
  ready ??= buildApp().then(async (app) => {
    await app.ready();
    return app;
  });
  const app = await ready;
  app.server.emit('request', req, res);
}
