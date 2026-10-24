# Plan and decisions

The one place for what is decided and what comes next. Every item ships as its own small PR. Details live in
[LOGIN_PLAN.md](LOGIN_PLAN.md), [CONTENT_PLAN.md](CONTENT_PLAN.md) and [DESIGN.md](DESIGN.md); when they
disagree with this page, this page wins until they are updated.

## Owner decisions

| Topic | Decision |
|---|---|
| How we work | Small, focused PRs (one concern each). CJ reviews and merges; nothing merges itself. |
| Email | App email goes through Purelymail SMTP from `noreply@terminuscli.com` (Purelymail mailbox names have no symbols). Not Resend. |
| Sites | `main` deploys **terminuscli** (https://terminuscli.com). `site/wayne-mitchell` deploys **terminus-wm** (https://terminus.wayne-mitchell.com), the private test site. Changes flow from `main` into `site/wayne-mitchell`, never the other way. |
| Previews | Test features are previewed only on the test domain (`<branch>.terminus.wayne-mitchell.com`). The live site posts no preview links. The test site's addresses are behind Cloudflare Access. |
| Tone | Calm and clear by default, but the app should feel encouraging and fun: short, excited praise is allowed where a learner earns it (see the exceptions in DESIGN.md). Example: "Review complete!" |
| Review rounds | Feedback on each answer during the round, "Review complete!" at the end, no final score. |
| Content cadence | Content work starts now, alongside the portal and fix work. A scheduled task runs every Monday at exactly 5:00 AM America/Chicago (`CRON_TZ=America/Chicago 0 5 * * 1`); a late start is fine. At least one real refresh a month. |
| Question and challenge pools | No cap on how many questions or challenges exist or are shown. Every question stays active; what appears first is rotated. Challenges, new and old, live in one data file and are swapped in at random. |
| Admins | CJ adds admins by email address from CJ's own account. Admin accounts are left out of all activity totals, analytics and tracking. Admins get a "view as" setting to use the site as another account level (for example a signed-out visitor or a regular student). |

## Login portal parts

1. Foundation (done, #15)
2. Email sign-up and sign-in (done, #17)
3. Email verification over Purelymail (done, #22)
4. Password reset, plus the open email-claim fixes (SV3-1 remainder, SV3-3, SV3-4, SV3-11) (in review)
5. Accounts and account pages: account menu, `#/account`, the `#/account/verify` page. `SMTP_PASSWORD` is set only after this ships.
6. Google sign-in, with the router rewrite (absorbs round-3 PR 6: shared helpers, `APP_ORIGINS`)
7. Security: the security page (sessions, linked sign-ins, delete account) and the security headers / CSP
8. Progress sync (new migrations start at `0005`)
9. Admin dashboard: admin allowlist managed by CJ, "view as" setting, admins excluded from tracking, opt-in most-missed totals for content

Rules for parts 4-9: port from `portal/base` by hand, never copy whole files from it; keep `worker/smtp.ts` and Purelymail; no Resend.

## Order of work

**Now**
1. Bring `site/wayne-mitchell` up to date with `main`, keeping its own `name`, `routes` and `preview_urls` (the test site still lacks the freeze guard).
2. Docs: README accounts section and privacy text, `RATE_LIMIT_PEPPER` / `APP_ORIGINS` / per-Worker secrets, Node 22.13.
3. Content start: challenge pool without a cap and with random rotation; tone exceptions in DESIGN.md and "Review complete!".

**Then, interleaved** (one PR at a time)
- The 15 confirmed bugs in [issue #28](https://github.com/cjmit18/Terminalpractice/issues/28), one small PR each with a regression test, starting with the service-worker cache deletion, verification-token replacement, fabricated lab answers, and identity/permission bugs.
- Portal parts 4-9 in order.
- Content build steps 1-6 from CONTENT_PLAN.md, and the Monday task.
- The open round-3 simulator fixes (PRs 8-24 in the round-3 plan): option parsing, trailing newlines, sort keys, script arguments, su/sudo, honest "not simulated" builtins, find predicates, awk, findstr, drives, shell fidelity, lesson text, app polish.
- Design fixes: phone touch targets, `--subtle` contrast, Mono 600.

The full scan reports (round 3 and round 4) are summarised here; their open items are the list above. Issue #28 tracks its own 15 findings until each is fixed.
