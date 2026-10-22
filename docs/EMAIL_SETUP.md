# Setting up account emails (Resend)

Email + password accounts work without any email setup, but then nobody gets the "confirm your email"
or "reset your password" messages, and the app says so. To send them, the Worker uses
[Resend](https://resend.com), which has a free plan (about 3,000 emails a month, 100 a day), plenty for
this site. You need two things: a **Resend API key** (a secret, Cloudflare only) and a sender address
in `EMAIL_FROM` (public, in `wrangler.jsonc`).

## 1. Create a Resend account

1. Go to <https://resend.com> and click **Sign up**. The free plan needs no card.
2. Confirm your email address when Resend asks.

## 2. Verify the domain terminuscli.com

Resend only sends from a domain that proves it is yours, which also keeps the emails out of spam.

1. In Resend, open **Domains → Add domain**, type `terminuscli.com`, pick the region closest to most
   learners (any is fine) and click **Add**.
2. Resend shows a few DNS records (an MX record and TXT records for SPF and DKIM, usually on a
   `send` subdomain and `resend._domainkey`). Leave this page open.
3. In another tab, open the Cloudflare dashboard → the `terminuscli.com` zone → **DNS → Records**.
   For each record Resend shows, click **Add record** and copy the **Type**, **Name** and **Value**
   (and **Priority** for MX) exactly. Set **Proxy status** to **DNS only** if Cloudflare offers it.
   (Resend can also add them for you through its Cloudflare button; either way works.)
4. Back in Resend, click **Verify DNS records**. It can take a few minutes. When the domain shows
   **Verified**, you can send from any address `@terminuscli.com`.

Optional but recommended: add a DMARC record in Cloudflare DNS, type `TXT`, name `_dmarc`, value
`v=DMARC1; p=none;`.

## 3. Create the API key and give it to the Worker

1. In Resend, open **API Keys → Create API key**. Name: `terminuscli worker`. Permission: **Sending
   access**, domain `terminuscli.com`. Click **Add**. The key (starts with `re_`) is shown once.
2. Put it into Cloudflare **only**. Never paste it into the repository, a chat, an issue or an email.
   Either:
   - in a terminal in this repository: `npx wrangler secret put RESEND_API_KEY`, then paste the key
     when it asks; or
   - in the Cloudflare dashboard: **Workers & Pages → terminuscli → Settings → Variables and Secrets
     → Add**, type **Secret**, name `RESEND_API_KEY`, paste the key, **Deploy**.

If you lose the key, delete it in Resend and create a new one; there is no need to recover it.

## 4. Set the sender address

In `wrangler.jsonc`, under the top-level `vars` (not under `previews`), set:

```jsonc
"EMAIL_FROM": "Terminus CertSim <accounts@terminuscli.com>",
```

The part before `@` can be anything; the domain must be the one verified in step 2. Commit and deploy.

## 5. Check it

Open `https://terminuscli.com/api/me`: it should show `"emailSending": true`. Create a test account
with your own address, or use "Forgot password": the email should arrive within a minute. The links in
it open the app at `#/account/verify` or `#/account/reset` on the same address the request came from.

Pull-request previews never send email: `EMAIL_FROM` is empty there, and previews have no accounts.

## If something goes wrong

- **`emailSending` is false**: `RESEND_API_KEY` or `EMAIL_FROM` is missing on this deployment.
- **No email arrives**: check the Resend dashboard's **Emails** (or **Logs**) page. A "domain not
  verified" error means step 2 is not finished, or `EMAIL_FROM` uses another domain. Also check spam.
- The Worker log shows `email: Resend answered <status>` when Resend refuses a message. It never logs
  addresses or links.
