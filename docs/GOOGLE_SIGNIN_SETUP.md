# Setting up "Sign in with Google"

The code for Google sign-in is already in the Worker (`worker/auth/google.ts`). It stays switched off
until you give it two values: a **Client ID** (public, goes in `wrangler.jsonc`) and a **Client secret**
(private, goes into Cloudflare only). This guide walks through getting both. It takes about 15 minutes.

You need a Google account. A Google Cloud project is free for this; no billing account is needed.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in.
2. At the top, click the project picker, then **New project**.
3. Name it `Terminus CertSim` and click **Create**. Make sure the new project is selected in the picker.

## 2. Set up the consent screen

This is the screen people see when they choose "Sign in with Google".

1. In the left menu, go to **APIs & Services → OAuth consent screen** (newer consoles call this
   **Google Auth Platform → Branding**). Click **Get started** if asked.
2. App name: `Terminus CertSim`. User support email: your own address.
3. Audience / user type: **External**.
4. Contact email: your own address. Accept the policy and click **Create**.
5. Under **Branding**, add the app home page `https://terminuscli.com` and the authorized domains
   `terminuscli.com` and `wayne-mitchell.com`.
6. Under **Data access** (or **Scopes**), click **Add or remove scopes** and tick only these three:
   - `openid`
   - `.../auth/userinfo.email` (shown as `email`)
   - `.../auth/userinfo.profile` (shown as `profile`)

   Do not add any other scope. These three are "non-sensitive", so Google does not need to review the app.
7. Under **Audience**, click **Publish app** so anyone can sign in (while in "Testing", only the test
   users you list can).

## 3. Create the OAuth client

1. Go to **APIs & Services → Credentials** (or **Google Auth Platform → Clients**).
2. Click **Create credentials → OAuth client ID** (or **Create client**).
3. Application type: **Web application**. Name: `Terminus CertSim Worker`.
4. **Authorized JavaScript origins**: leave empty (the browser never talks to Google directly).
5. **Authorized redirect URIs**: add each of these exactly, one per line:

   ```
   https://terminuscli.com/api/auth/google/callback
   https://terminus.wayne-mitchell.com/api/auth/google/callback
   http://localhost:8787/api/auth/google/callback
   ```

   The Worker builds the callback from the address it was reached on, so every address you use needs
   its own line here. The `localhost` line is for `npm run dev:cf` on your own computer.
6. Click **Create**. A box shows the **Client ID** (ends in `.apps.googleusercontent.com`) and the
   **Client secret**. Keep this tab open.

## 4. Give the values to the Worker

**Client ID (public).** Put it in `wrangler.jsonc` under the top-level `vars` (not under `previews`):

```jsonc
"GOOGLE_CLIENT_ID": "1234567890-abc123.apps.googleusercontent.com",
```

Commit and deploy as usual. The Client ID is not a secret; it appears in the sign-in link anyway.

**Client secret (private).** Never put it in the repository, a chat, an issue or an email. Set it only
in Cloudflare, either:

- in a terminal in this repository: `npx wrangler secret put GOOGLE_CLIENT_SECRET`, then paste the
  secret when it asks; or
- in the Cloudflare dashboard: **Workers & Pages → terminuscli → Settings → Variables and Secrets →
  Add**, type **Secret**, name `GOOGLE_CLIENT_SECRET`, paste the value, **Deploy**.

For local development, put it in `.dev.vars` (already git-ignored) on your own computer:
`GOOGLE_CLIENT_SECRET=...`

## 5. Check it

Open `https://terminuscli.com/api/me`. It should show `"google": true` under `providers`. In the app,
the account page now offers "Sign in with Google".

Pull-request previews keep Google switched off (`GOOGLE_CLIENT_ID` is empty under `previews`).

## Adding another domain later

Add one more redirect URI in step 3.5 (`https://<new domain>/api/auth/google/callback`) and add the
domain under the consent screen's authorized domains. No code change is needed.

## If something goes wrong

- **"redirect_uri_mismatch"** from Google: the address in the browser is not in the redirect URI list
  exactly (check `http` vs `https`, `www.`, and the path).
- **503 "not set up"**: the Client ID or the secret is missing on this deployment.
- **"This sign-in link expired"**: the sign-in took over 10 minutes, or started in another browser. Try again.
