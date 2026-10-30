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
4. Password reset, plus the open email-claim fixes (SV3-1 remainder, SV3-3, SV3-4, SV3-11) (done, #49)
5. Accounts and account pages: account menu, `#/account` (sign in, create account, the account page), `#/account/forgot`, `#/account/verify`, `#/account/reset` (done, #50). `SMTP_PASSWORD` is set only after this ships.
6. Google sign-in, with the router rewrite (absorbs round-3 PR 6: shared helpers, `APP_ORIGINS`)
7. Security: the security page (sessions, linked sign-ins, delete account) and the security headers / CSP. 7a: the account API (`/api/account`, sessions, password, unlink, export, delete) (done, #56); 7b: the security page (done, #57); 7c: security headers / CSP for the whole site (done, #58); 7d: add a way to sign in: link GitHub to an email account (`?link=1`), add email and a password to a GitHub account (`POST /api/account/email`) (in review)
8. Progress sync: 8a the server (done, #53), 8b the app's sync engine and the Auto save button (done, #54)
9. Admin dashboard: admin allowlist managed by CJ, "view as" setting, admins excluded from tracking, opt-in most-missed totals for content. 9a: the admin API (owner from the `OWNER_EMAIL` secret, admins table in migration 0006, last sign-in time in 0007, `/api/admin/stats`, `/api/admin/admins`) (done, #59); 9b: the `#/admin` page and "view as" (done, #60); 9c: opt-in most-missed questions, in two PRs: the API (sharing off by default, `/api/answers`, `/api/answers/sharing`, `/api/admin/missed`, migration 0008) (done, #61), then the app (the sharing switch, sending answers, the admin list) (in review)
10. Stronger password hashing: passwords are PBKDF2-SHA256 at 100,000 iterations today (`worker/password.ts`), the most Workers allow for PBKDF2 and below OWASP's 600,000. Move new hashes to Argon2id (WebAssembly, tuned to the Worker's CPU limit), keep `verifyPassword` reading the old `pbkdf2$…` lines, and rehash each account on its next successful sign-in. Needs a CPU-time check on the live Worker first.

Rules for parts 4-10: port from `portal/base` by hand, never copy whole files from it; keep `worker/smtp.ts` and Purelymail; no Resend.

Migrations: the test site shares the accounts database and applies migrations when it deploys, so a migration in an open pull request reaches the live database before the merge. Migrations must be additive, and a migration file is never edited once its pull request is open (its first version is recorded as applied); fix it with a new migration instead.

## Order of work

**Now**
1. Bring `site/wayne-mitchell` up to date with `main`, keeping its own `name`, `routes` and `preview_urls` (the test site still lacks the freeze guard).
2. Docs: README accounts section and privacy text, `RATE_LIMIT_PEPPER` / `APP_ORIGINS` / per-Worker secrets, Node 22.13.
3. Content start: challenge pool without a cap and with random rotation; tone exceptions in DESIGN.md and "Review complete!".

**Then, interleaved** (one PR at a time)
- The open bugs from issues #28 and #51, in the order of the bug-fix plan below.
- Portal parts 4-9 in order.
- Content build steps 1-6 from CONTENT_PLAN.md, and the Monday task.
- The open round-3 simulator fixes (PRs 8-24 in the round-3 plan): option parsing, trailing newlines, sort keys, script arguments, su/sudo, honest "not simulated" builtins, find predicates, awk, findstr, drives, shell fidelity, lesson text, app polish.
- Design fixes: phone touch targets, `--subtle` contrast, Mono 600.

The full scan reports (round 3 and round 4) are summarised here; their open items are the list above. Issues #28 and #51 track their own findings until each is fixed.

## Bug-fix plan (issues #28 and #51)

Each fix is its own small PR with a regression test that fails before the fix. Race fixes put the guard in the same
SQL statement as the write and prove it with an interleaving test. Batch A comes first: account recovery and session
integrity go before more account features (part 6, Google sign-in).

**Already fixed:** #28 findings 1 (service-worker caches, #37), 2 (one working verification link), 3 (echoed lab
answers), 4 (the adm challenge, #40) and 5 (`rm -r` permissions). #51 finding 5 (the sign-in page promising progress
on other devices) became true when sync shipped in part 8.

**A. Accounts (#51 1-4, #28 14)**

| # | Finding | Fix |
|---|---|---|
| A1 | #51-1: a registration still in flight can make a session after the inbox owner resets the password | Registration and reset make their sessions with `createPasswordSession`, bound to the hash they set, like sign-in |
| A2 | #51-2: an older reset that resumes late overwrites a newer completed reset | The reset's UPDATE also requires that no newer reset link exists for the account (`NOT EXISTS` a higher rowid) |
| A3 | #51-3: a slow `/api/me` answer undoes a newer sign-in or sign-out in the app | A generation counter in the account store: sign-in, sign-up, reset and sign-out bump it; older answers are dropped |
| A4 | #51-4: "Forgot password" says a link was sent when the server failed | Only the server's 202 shows "sent"; a 5xx or refused request shows a retry message (no hint whether the account exists) |
| A5 | #28-14: a resent confirmation email promises 24 hours when the claim ends sooner | The email states the real time left, and an expired claim explains the next step |

**B. Linux simulator (#28 6-10)**

| # | Finding | Fix |
|---|---|---|
| B1 | #28-6: `ls -R` lists inside a directory it cannot search | Check search (x) permission on each directory before descending |
| B2 | #28-7: `cd` and `umask` in a pipeline change the shell | Pipeline stages run builtins on a copy of the shell state; file changes still land |
| B3 | #28-8: `su student` becomes root | `su [-] [user]`: switch to the named user, refuse unknown users, root when none is given |
| B4 | #28-9: `cp -r` of a read-only directory copies nothing | Copy the children first, then apply the source's mode |
| B5 | #28-10: `cp -p` does not set the mode on an existing destination | Apply preserved mode and owner to existing destinations too |

**C. Windows simulators (#28 11-13)**

| # | Finding | Fix |
|---|---|---|
| C1 | #28-11: two AD accounts can share a SID and GUID | A counter per directory gives each object its own RID; GUIDs from the same counter |
| C2 | #28-12: `Get-ADGroupMember -Recursive` stops at nested groups | Walk nested groups with a visited set; users once each |
| C3 | #28-13: DiskPart formats the running C: volume | `format` gets the same system/boot-volume refusal as `delete` and `clean` |

**D. App (#28 15)**

| # | Finding | Fix |
|---|---|---|
| D1 | #28-15: a lab finished in one tab is celebrated again in another | The badge and milestone effects share the "from another tab" flag; milestones from another tab update quietly |

**Decisions needed (held back in #28)**
- A GitHub sign-in keeps an email session already in the browser, while an email sign-in replaces it. Proposal: GitHub
  sign-in ends the incoming session too, the same rule for every method.
- `New-Item -Force` on an existing file: needs a check against real PowerShell before changing.
