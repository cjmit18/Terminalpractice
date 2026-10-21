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

## When you buy a domain

1. Add it to the Worker: **terminuscli** → **Settings** → **Domains & Routes** → **Add** → **Custom domain**.
2. In the GitHub App, **add** a callback URL `https://your-domain/api/auth/github/callback` and change the Homepage URL. Keep the `workers.dev` one while you switch over (a GitHub App takes up to 10 callback URLs).
3. Nothing changes in the code: the server builds its callback address from the address it was reached on.

Sessions are per address, so learners sign in once more on the new domain.

## Testing on your computer

Create a file `.dev.vars` in the project (it is git-ignored) with:

```
GITHUB_CLIENT_ID=Iv...
GITHUB_CLIENT_SECRET=...
```

Then `npm run dev:cf` and open <http://localhost:8787>. This uses a local copy of the database, not the real one.
