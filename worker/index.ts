// Cloudflare Worker entry: /api/* is the account API, everything else is the static app.
// wrangler.jsonc routes only /api/* here (run_worker_first), so static files never pay for this code.
// The daily cron (triggers.crons in wrangler.jsonc) runs scheduled(): the sweep of expired rows.
import { handleApi, type ApiEnv } from './api';
import { defaultDeps } from './http';
import { sweepExpired } from './maintenance';
import { smtpSend } from './smtp';

interface Env extends ApiEnv {
  ASSETS: Fetcher;
  DB: D1Database;
}

export default {
  async fetch(request, env, ctx) {
    // waitUntil lets emails go out after the answer is sent, so sign-up stays fast and its timing says nothing
    const deps = { ...defaultDeps, waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p), sendMail: smtpSend };
    return (await handleApi(request, env, deps)) ?? env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sweepExpired(env.DB, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
