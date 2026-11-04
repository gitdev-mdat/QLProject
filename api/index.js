// Vercel Function entry for the existing Fastify API (worker API, public wake/dispatch, legacy agent API).
// The Fastify app is unchanged: it is built by `npm run build` (tsc → dist/) and every request is handed to it.
// No timers or background loops run here: job materialisation, lease expiry and recovery all happen inside
// request transactions (see docs/production-environments.md).
import { app } from '../dist/src/server.js';

const ready = app.ready();

export default async function handler(req, res) {
  await ready;
  app.server.emit('request', req, res);
}
