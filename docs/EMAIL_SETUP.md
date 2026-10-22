# Account emails (Purelymail)

The app sends one kind of email today: the link that confirms a new account's address. Password reset links will follow. They go out from a Purelymail mailbox over SMTP, sent by the Worker (`worker/smtp.ts`, using the `worker-mailer` package pinned to 1.2.1).

## One-time setup

1. **Create the sending mailbox in Purelymail.** Use `no-reply@terminuscli.com` with its own long, random password, used nowhere else. Don't send from your personal mailbox: the Worker holds this password, so keep it separate.
   - To use a different address, change `SMTP_USER` in `wrangler.jsonc`.
2. **Give the Worker the password.** In the Cloudflare dashboard, go to **Workers & Pages → terminuscli → Settings → Variables and Secrets → Add**.
   - Choose type **Secret** (not Text), name it `SMTP_PASSWORD`, paste the password and click **Deploy**.
   - From a terminal instead: `npx wrangler secret put SMTP_PASSWORD`.
   - Never commit the password or paste it into an issue or chat.
3. **Domain records.** These are already in place if Purelymail shows terminuscli.com as verified. The SPF, DKIM and DMARC records for Purelymail let these emails pass spam checks, so no other DNS changes are needed.

## Settings

| Name | Where | Default | Meaning |
|---|---|---|---|
| `SMTP_USER` | `wrangler.jsonc` vars | `no-reply@terminuscli.com` | The mailbox that signs in to send |
| `SMTP_PASSWORD` | Secret | none | That mailbox's password; without it nothing is sent |
| `SMTP_HOST` | vars (optional) | `smtp.purelymail.com` | Mail server |
| `SMTP_PORT` | vars (optional) | `465` | 465 uses TLS from the start; 587 uses STARTTLS |
| `EMAIL_FROM` | vars (optional) | `SMTP_USER` | Sender address shown to the reader, as "Terminus CertSim" |
| `REPLY_TO` | vars (optional) | none | Where replies go, e.g. a support inbox |

Preview builds have none of these, so they never send email.

## How it behaves

- Emails are sent after the answer goes back to the browser, so sign-up stays fast. If the mail server is down, sign-up still succeeds, and the person can ask for a new link later (3 per hour).
- Links work once. A confirm link expires after 24 hours, and asking for a new one stops the old one working. Only a hash of each link's token is stored.
- Opening a confirm link confirms the address but doesn't sign anyone in.
- The Worker logs nothing about who an email went to.
