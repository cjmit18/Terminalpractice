// Cloudflare Worker entry: /api/* is the account API, everything else is the static app.
// wrangler.jsonc routes only /api/* here (run_worker_first), so static files never pay for this code.
// The daily cron (triggers.crons in wrangler.jsonc) runs scheduled(): the sweep of expired rows.
import { handleApi, type ApiEnv } from './api';
import { sweepExpired } from './maintenance';

interface Env extends ApiEnv {
  ASSETS: Fetcher;
  DB: D1Database;
}

export default {
  async fetch(request, env) {
    return (await handleApi(request, env)) ?? env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sweepExpired(env.DB, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
