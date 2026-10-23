# Setting up "Sign in with GitHub"

The code is in place; sign-in stays hidden until these steps are done. You need: your GitHub account, the Cloudflare dashboard, and about 10 minutes.

## 1. Your site address

The site runs on the Worker **terminuscli** at `https://terminuscli.com`. Below it is written as `https://YOUR-SITE`. (The Worker's `workers.dev` address, shown at the top of its page in **Workers & Pages**, works too and is handy for testing.)

## 2. Create the GitHub App

GitHub → your profile picture → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App** (or go to <https://github.com/settings/apps/new>).

| Field | Value |
|---|---|
| GitHub App name | `Terminus CertSim` (must be unique on GitHub; add something if it is taken) |
| Homepage URL | `https://YOUR-SITE` |
| Callback URL | `https://YOUR-SITE/api/auth/github/callback` |
| Add Callback URL (second row) | `http://localhost:8787/api/auth/github/callback` (for testing on your computer) |
| Expire user authorization tokens | leave as is |
| Request user authorization (OAuth) during installation | leave **unticked** |
| Webhook → Active | **untick** (the site does not use webhooks) |
| Permissions | leave everything at **No access** (sign-in only reads your public profile) |
| Where can this GitHub App be installed? | **Any account** (so any learner can sign in) |

Click **Create GitHub App**. On the next page:

- Copy the **Client ID** (starts with `Iv`). It is public, not a secret.
- Click **Generate a new client secret** and copy it right away. GitHub shows it only once. Treat it like a password: do not paste it in chat, an issue or the code.

## 3. Give the server the two values

**Client ID:** send it to me and I will put it in `wrangler.jsonc` (`vars.GITHUB_CLIENT_ID`), or edit that line yourself.

**Client secret:** add it in Cloudflare yourself, so it never touches the repository:

- Dashboard → **Workers & Pages** → **terminuscli** → **Settings** → **Variables and Secrets** → **Add** → type **Secret**, name `GITHUB_CLIENT_SECRET`, paste the value, **Deploy**.
- Or from a terminal in the project: `npx wrangler secret put GITHUB_CLIENT_SECRET` and paste when asked.

## 4. Deploy with the database schema

The deploy command now creates the account tables before deploying:

- In the Cloudflare dashboard → **terminuscli** → **Settings** → **Builds**, set the **Deploy command** to `npm run deploy`.
- Or deploy from your computer: `npx wrangler login` once, then `npm run deploy`.

## 5. Check it

Open `https://YOUR-SITE`. A **Sign in** button appears at the top right. Sign in, approve on GitHub, and you come back to the page you were on with your name in the corner.

## Adding another domain

The site has two addresses today, each served by its own Worker:

| Address | Worker | Deployed from |
|---|---|---|
| `https://terminuscli.com` | `terminuscli` | `main` (custom domain listed in `wrangler.jsonc` routes) |
| `https://terminus.wayne-mitchell.com` | `terminus-wm` | the separate `site/wayne-mitchell` branch (custom domain set in its `wrangler.jsonc` `routes`) |

Both can use the same GitHub App. For each address, including a new one:

1. Attach the domain to its Worker: **Workers & Pages** → the Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**, or add it to that Worker's `wrangler.jsonc` as a `routes` entry with `"custom_domain": true`, as `terminus-wm` does.
2. In the GitHub App, **add** a callback URL `https://that-address/api/auth/github/callback`. Keep the existing ones: a GitHub App takes up to 10 callback URLs, and each address needs its own. The Homepage URL can stay `https://terminuscli.com`.
3. Give that Worker the two values (as in section 3 above): the Client ID in its `wrangler.jsonc` (`vars.GITHUB_CLIENT_ID`) and the secret with **Variables and Secrets** on that Worker (secrets are per Worker, so `terminus-wm` needs its own `GITHUB_CLIENT_SECRET`).
4. Nothing else changes in the code: the server builds its callback address from the address it was reached on.

Both Workers currently use the same D1 database (`terminalpractice`), so they share accounts, but the session cookie stays on the exact host, so learners sign in separately on each address. Give a Worker its own database by creating one and changing its `database_id` in `wrangler.jsonc`. Apply the migrations to a new Worker's database with its deploy command (`npm run deploy`).

## Testing on your computer

Create a file `.dev.vars` in the project (it is git-ignored) with:

```
GITHUB_CLIENT_ID=Iv...
GITHUB_CLIENT_SECRET=...
```

Then `npm run dev:cf` and open <http://localhost:8787>. This uses a local copy of the database, not the real one.
