# Terminus CertSim

A browser-based terminal simulator for IT certification practice. Everything runs in the browser: it installs as an app on phones and desktops and works offline after the first visit. An account (email and password, or GitHub) is optional.

> **About this project.** Terminus CertSim was built with AI assistance: much of the code and lesson content was generated with AI tools (Google AI Studio, Anthropic's Claude, GitHub Copilot) working from my direction and review. I maintain and develop it myself ([@cjmit18](https://github.com/cjmit18)) as a personal project for my own learning and practice for the LPIC-1 and CompTIA exams. It is a study aid, not official exam material: check anything important against the official objectives.
>
> Not affiliated with or endorsed by the Linux Professional Institute (LPI) or CompTIA. LPIC-1, CompTIA, A+, Network+ and Security+ are trademarks of their respective owners.

Covers hands-on objectives for:
- **LPI Linux** (LPIC-1 101/102): permissions, text processing, system architecture, user administration, disk partitioning
- **CompTIA Windows PBQs** (A+, Network+, Security+ style): network troubleshooting, Active Directory, Group Policy, DiskPart, incident response, SFC/DISM, PowerShell

## What's in the app

- **Learn paths** (the start page, `#/learn`): four guided courses covering five exams (LPIC-1 101 and 102, CompTIA A+ Core 2, and one path for Network+ and Security+ on Windows), plus "Your first terminal" for people who have never used one. Each exam path has five stages, suggested in order but never locked, and mixes short lessons, the labs below and checkpoint quizzes.
- **First-steps banner**: until anything is saved, the Learn page offers "Your first terminal"; once dismissed it stays hidden in that browser.
- **Checkpoint quizzes**: multiple-choice questions at the end of each stage, with a pass mark and the best score kept. Every question is asked each time, in a new order on every attempt.
- **Review queue**: checkpoint questions come back for review on a spaced schedule, missed ones sooner. Feedback on each answer, "Review complete!" at the end, no score.
- **Challenges**: short puzzles on the lab machines, answered with a command or two. All of them stay open; the list is shown in a new random order each day, with one as "Today's pick".
- **Skill map, field guide and weekly goal**: what you have practised per exam objective, every command grouped by shell and area with quiet ticks for seen, ran and read, and an optional practice goal for the week (no streaks).
- **14 guided labs**: 6 Linux and 8 Windows, including a first-steps lab on each side. Each has a short scenario, a task list that is checked against the simulated system's real state, hints, exam tips and a walkthrough you can run step by step. Hints come as a ladder: a nudge first, then the command's shape, then the answer.
- **Explanations when you are blocked**: when a command fails with "Permission denied", the terminal adds a short note saying which permission check failed and why.
- **Sandbox**: free-form bash, Command Prompt and PowerShell sessions, with a file tree that shows the real simulated filesystem, permissions and owners.
- **Simulators**: Active Directory Users and Computers, Group Policy Management, Disk Management, a network diagram and a file permission calculator.
- **Command reference**: searchable pages with syntax, options, examples and exam notes. The same pages answer `man`, `--help`, `help`, `/?` and `Get-Help` inside the terminal.
- **Badges**: earned for a new ability or a curious act (reading a manual page, fixing an error, finishing a path), never for repeating a command. They survive resets.
- **Celebrations**: a short note when you finish a task, a lab or a stage or earn a badge, and a recap at the end of a lab or stage.
- **Game settings** (on the Learn page): show or hide badges, and set celebrations to Quiet, Off or Lively (Lively adds confetti for a finished stage or path, skipped when the system asks for reduced motion).
- **Progress is saved** in your browser and kept in step between open tabs, and every page has its own URL, so links and the back button work.
- **Light and dark themes** (follows your system unless you choose one).
- **Phone support**: one pane at a time in labs, a key toolbar (`Tab`, `Ctrl+C`, arrows and the symbols phone keyboards hide) and an input that does not autocorrect commands.
- **Installable and offline**: web app manifest, icons and a service worker. Fonts (IBM Plex Sans and Mono) are bundled, so nothing is fetched from third parties.

### Simulated command support

- **Linux:** files (`ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `find`, `tar`), text (`grep` with `-r -i -v -n -c -l -E`, `sed`, `awk`, `cut`, `tr`, `sort`, `uniq`, `head`, `tail`, `wc`, `tee`), permissions and users (`chmod`, `chown`, `chgrp`, `umask`, `id`, `useradd`, `usermod`, `sudo`, `su`), system (`systemctl`, `journalctl`, `ps`, `kill`, `df`, `free`, `fdisk -l`, `lspci`, `lsmod`, `dmesg`, `date`, `which`, `history`), network (`ip`, `ping`, `ss`, `netstat`), plus `export`, `env`, `source` and running scripts
- **Command Prompt:** `dir`, `cd`, `type`, `mkdir`, `copy`, `del`, `set` and `%VAR%` expansion, `ver`, `systeminfo`, `ipconfig`, `ping`, `tracert`, `nslookup`, `netstat`, `route print`, `tasklist`, `taskkill`, `gpupdate`, `gpresult`, `sfc`, `dism`, `chkdsk`, `net user`, `findstr` and an interactive `diskpart`
- **PowerShell:** `Get-ChildItem`, `Get-Content`, `Get-Location`, `Get-Service`, `Start-Service`, `Get-Process` (with `Where-Object`), `Test-NetConnection` and the Active Directory cmdlets the labs use
- **Shell features:** pipes, `>`, `>>`, `2>`, `2>&1`, `/dev/null`, quoting that follows each shell's rules, and `&&`, `||`, `;` in bash and `&`, `&&`, `||` in CMD

## Project layout

```
docs/                       # DESIGN.md (UI tokens, type, layout, copy rules), sign-in setup and plan
src/
├── main.tsx                # entry: mounts the app, registers the service worker
├── App.tsx                 # routes, saved progress, page layout
├── index.css               # Tailwind and the design tokens for both themes
├── lib/                    # hash router, storage (progress, journey, activity, synced across tabs),
│                           #   theme, account, celebrations, chunk reload after a deploy, API base
├── components/
│   ├── journey/            # Learn paths: path list, overview, lessons, quizzes, first-steps banner
│   ├── lab/                # lab manual, page header, shell session hook, file tree
│   ├── challenges/         # challenge list (daily rotation) and challenge page
│   ├── fieldguide/         # the field guide of commands
│   ├── badges/             # badge list and names
│   ├── celebrate/          # celebration notes, recaps, confetti
│   ├── settings/           # game settings (badges, celebrations)
│   ├── sims/               # shared UI pieces (buttons, code blocks, segmented controls)
│   └── *.tsx               # header, account menu, lab list and runner, terminal, sandbox,
│                           #   simulators, command reference, error boundary
├── terminal/
│   ├── registry.ts         # command registry shared by both engines
│   ├── chain.ts            # &&, ||, ; runner
│   ├── parser.ts           # CMD and PowerShell tokenizer, pipelines, redirects (bash: linux/shell.ts)
│   ├── filesystem.ts       # virtual filesystem, permission checks and explanations
│   ├── linux/              # bash syntax and expansion (shell.ts), context, input helpers, awk,
│   │                       #   globbing, scripts, commands by area
│   ├── windows/            # CMD commands by area, PowerShell, DiskPart, variables
│   ├── docs/               # built-in documentation and its renderers (man, --help, /?, Get-Help)
│   ├── linuxEngine.ts      # executeLinuxLine
│   ├── windowsEngine.ts    # executeWindowsLine
│   └── *.test.ts           # unit, regression and walkthrough replay tests
├── data/                   # labs, Windows PBQs, learning paths, badges, verifiers, command reference
└── types/
worker/                     # Cloudflare Worker: the optional account API (/api/*) and its tests
migrations/                 # D1 database schema
e2e/                        # Playwright browser tests
public/                     # web app manifest, service worker, icons
```

## Development

Requires Node.js 22.13 or newer (the worker tests use the built-in `node:sqlite`).

```bash
npm ci
npm run dev        # dev server on http://localhost:3000
npm test           # unit tests (app and worker)
npm run lint       # three typechecks: the app, the worker, and the worker tests (no ESLint)
npm run build      # typecheck the app, then production build into dist/
npm run preview    # serve the production build
npm run e2e        # browser tests (builds, then serves on port 4173)
```

Before the first `npm run e2e`, install the browser with `npx playwright install chromium`. If a Chromium is already installed elsewhere (a sandbox, for example), point `PW_CHROMIUM_PATH` at it instead. The tests run on a desktop and a phone (Pixel 7) profile.

### Tests

`npm test` runs the Node test runner through `tsx` over every `*.test.ts` in `src/` and `worker/`. Besides unit tests for the parsers, filesystem, both engines, the learning paths and badges, it includes:

- **Walkthrough replay:** every module's own solution steps are run through the engine, and every objective's verifier must pass. A module that cannot be completed fails `npm test` (and so the Cloudflare build, which runs the tests first).
- **Account API tests:** `worker/*.test.ts` (see below).
- **Regression tests** for each bug found in review (`ls -ld`, `chmod -R` with files you do not own, `tar` flag parsing, `usermod` with unknown users, `id` group numbers, CMD `2>&1`, `ls -l` on unreadable files).

### Adding a command

Commands live in `src/terminal/linux/commands/` and `src/terminal/windows/` by area and register themselves in the engine's registry. Read files through the shared input helper so named files and stdin behave the same, use the context's permission helpers so denials come with an explanation, and add tests next to the existing ones.

### UI changes

Read `docs/DESIGN.md` first. Use the design tokens (`bg-surface`, `text-muted`, `border-line`, `text-accent`...) rather than raw Tailwind palette colors, and check both themes.

### Adding a module

Add it to `src/data/lpiModules.ts` or `src/data/windowsPbqs.ts`, with a one-sentence `summary` for the lab list. Verifiers receive the filesystem, system state and the last command (`CommandContext`: command, exit code, stdout). Check success and evidence in the output, not just the command text. Put the commands a student types in `solutionWalkthrough`, one per line; the replay test will tell you if they do not satisfy every objective.

## Deployment

The app is static and works without any server. On Cloudflare, a small Worker adds an optional account API (email and password, or GitHub); everywhere else the app simply does not offer sign-in.

### Cloudflare Workers

`wrangler.jsonc` describes the Worker `terminuscli`, which serves https://terminuscli.com: it serves `dist/` as static assets and runs `worker/index.ts` only for `/api/*` (`run_worker_first`), with a D1 database (`DB`) for accounts. Cloudflare Workers Builds is connected to this repository: pushes to the production branch deploy, and pull-request builds run `wrangler preview`. The live site posts no preview links (`preview_urls: false`); pull requests are previewed on the private test site at `https://<branch>.terminus.wayne-mitchell.com`.

- Before every deploy or preview, wrangler runs the `build.command` from `wrangler.jsonc`: `npm test && npm run lint && VITE_BASE=/ npm run build`. A failing test or typecheck stops the deploy. The build image installs devDependencies, which is where `tsx`, `typescript` and `wrangler` come from.
- `npm run deploy`: applies new database migrations (`migrations/`) to the remote D1 database, then `wrangler deploy` (which runs the build command and its tests). Migrations therefore run before the tests: keep each migration safe for the code already deployed. Run `npx wrangler login` once before deploying from your machine. Set the same command as the **Deploy command** in the Workers Builds settings.
- **Previews:** the `previews` block in `wrangler.jsonc` is what `wrangler preview` uses (nothing is inherited from the top level). It turns sign-in off (`GITHUB_CLIENT_ID` empty) and binds a separate D1 database, `terminuscli-preview`, so a preview can never touch real accounts. No migrations are applied to that database on purpose: `/api/me` answers "signed out" when the account tables are missing, and the email sign-up and sign-in routes fail there because the tables are missing, so nothing is written and no email is sent (previews have no SMTP settings either).
- `npm run dev:cf`: the full stack locally (static app, Worker and a local D1 copy) at <http://localhost:8787>.
- Node 22 for Workers Builds comes from `.node-version`.
- Cloudflare builds use `VITE_BASE=/` (set in `wrangler.jsonc`), so a deep link such as `/old/path` still loads `/assets/...`; the default relative base keeps GitHub Pages' `/<repo>/` path working.

### Accounts (optional sign-in)

- **Email and password** (`worker/auth/email.ts`): sign-up, sign-in and email verification. Passwords are hashed with PBKDF2-SHA256; the email address is stored to sign in with and to send account emails (verification, and password reset next; sending starts once the account pages ship). Verification links are single-use and stored only as hashes. Emails go out over SMTP from `noreply@terminuscli.com` (Purelymail): see [docs/EMAIL_SETUP.md](docs/EMAIL_SETUP.md).
- **GitHub** (`worker/api.ts`): `/api/auth/github/start` and `/callback`. The GitHub token is used once to read the public profile and never stored. Setup: [docs/GITHUB_SIGNIN_SETUP.md](docs/GITHUB_SIGNIN_SETUP.md).
- `/api/me` and `/api/logout`. Sessions are random tokens in an `HttpOnly; Secure; SameSite=Lax` `__Host-` cookie; D1 stores only their SHA-256. Sign-up and sign-in are rate limited, which needs the `RATE_LIMIT_PEPPER` secret on each Worker (without it those routes answer "not configured").
- A daily job (`17 3 * * *`, `worker/maintenance.ts`) deletes expired sessions, one-time links and rate-limit rows.
- What comes next (password reset, account pages, Google, security page, sync, admin dashboard) is in [docs/PLAN.md](docs/PLAN.md).
- The callback address is built from the address the site was reached on, so another domain needs no code change. The private test site runs at https://terminus.wayne-mitchell.com (Worker `terminus-wm`, deployed from the `site/wayne-mitchell` branch, behind Cloudflare Access). Changes flow from `main` into that branch, never back; see "Adding another domain" in the setup guide.
- Tests: `worker/*.test.ts` run the API against Node's built-in SQLite with all migrations, a fake GitHub and a fake mailer; `e2e/account.spec.ts` covers the header control.

### GitHub Pages

After CI passes on a push to `main`, `.github/workflows/deploy.yml` typechecks, tests, builds and publishes `dist/` to GitHub Pages, with `VITE_ACCOUNTS=off` because that host has no account API. One-time setup: in the repository settings, under **Pages**, set **Source** to **GitHub Actions**. The build uses a relative base path, so it works from a project URL such as `https://<user>.github.io/<repo>/`. If Cloudflare becomes the only host, delete that workflow and turn Pages off.

The private test site (branch `site/wayne-mitchell`, Worker `terminus-wm`) is rebuilt by `.github/workflows/test-site.yml` on every push to `main` and every pull-request change: `main` plus every open pull request from this repository, merged in order (a pull request that conflicts is left out), with the test site's `wrangler.jsonc` from `scripts/site-config.mjs`. The branch is replaced each time, so never commit to it by hand. Its `#/testing` page lists what the build holds and what to try; each pull request with something to see adds `src/data/testing/pr-<number>.ts`.

CI (`.github/workflows/ci.yml`) runs the typechecks, tests, build and the browser tests on pushes and pull requests to `main` (and `master`). Pushes to other branches get no CI run of their own; open a pull request to test them.
