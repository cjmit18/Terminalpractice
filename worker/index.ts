// Cloudflare Worker entry: /api/* is the account API, everything else is the static app.
// wrangler.jsonc routes only /api/* here (run_worker_first), so static files never pay for this code.
import { handleApi, type ApiEnv } from './api';

interface Env extends ApiEnv {
  ASSETS: Fetcher;
  DB: D1Database;
}

export default {
  async fetch(request, env) {
    return (await handleApi(request, env)) ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
