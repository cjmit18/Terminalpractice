# Terminus CertSim

A browser-based terminal simulator for IT certification practice. It runs entirely on the client: no server, no accounts, no API keys. It installs as an app on phones and desktops and works offline after the first visit.

Covers hands-on objectives for:
- **LPI Linux** (LPIC-1 101/102): permissions, text processing, system architecture, user administration, disk partitioning
- **CompTIA Windows PBQs** (A+, Network+, Security+ style): network troubleshooting, Active Directory, Group Policy, DiskPart, incident response, SFC/DISM, PowerShell

## What's in the app

- **12 guided labs** (5 Linux, 7 Windows). Each has a short scenario, a task list that is checked against the simulated system's real state, hints, exam tips and a walkthrough you can run step by step.
- **Explanations when you are blocked**: when a command fails with "Permission denied", the terminal adds a short note saying which permission check failed and why.
- **Sandbox**: free-form bash, Command Prompt and PowerShell sessions, with a file tree that shows the real simulated filesystem, permissions and owners.
- **Simulators**: Active Directory Users and Computers, Group Policy Management, Disk Management, a network diagram and a file permission calculator.
- **Command reference**: searchable pages with syntax, options, examples and exam notes.
- **Progress is saved** in your browser, and every page has its own URL, so links and the back button work.
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
docs/DESIGN.md              # design brief: tokens, type, layout and copy rules for the UI
src/
├── App.tsx                 # routes, saved progress, page layout
├── lib/                    # hash router, progress storage, theme, module helpers
├── components/
│   ├── lab/                # lab manual, shell session hook, file tree
│   ├── sims/               # shared simulator UI pieces
│   └── *.tsx               # header, catalog, lab runner, terminal, sandbox, simulators, reference
├── terminal/
│   ├── registry.ts         # command registry shared by both engines
│   ├── chain.ts            # &&, ||, ; runner
│   ├── parser.ts           # tokenizer, pipelines, redirects
│   ├── filesystem.ts       # virtual filesystem, permission checks and explanations
│   ├── linux/              # bash context, input helpers, awk, commands by area
│   ├── windows/            # CMD commands by area, PowerShell, DiskPart, variables
│   ├── linuxEngine.ts      # executeLinuxLine
│   ├── windowsEngine.ts    # executeWindowsLine
│   └── *.test.ts           # unit, regression and walkthrough replay tests
├── data/                   # labs, Windows PBQs, command reference
└── types/
public/                     # web app manifest, service worker, icons
```

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev        # dev server on http://localhost:3000
npm test           # run the test suite
npm run lint       # typecheck (tsc --noEmit)
npm run build      # typecheck, then production build into dist/
npm run preview    # serve the production build
```

### Tests

`npm test` runs the Node test runner through `tsx`. Besides unit tests for the parser, filesystem and both engines, it includes:

- **Walkthrough replay:** every module's own solution steps are run through the engine, and every objective's verifier must pass. A module that cannot be completed fails the build.
- **Regression tests** for each bug found in review (`ls -ld`, `chmod -R` with files you do not own, `tar` flag parsing, `usermod` with unknown users, `id` group numbers, CMD `2>&1`, `ls -l` on unreadable files).

### Adding a command

Commands live in `src/terminal/linux/commands/` and `src/terminal/windows/` by area and register themselves in the engine's registry. Read files through the shared input helper so named files and stdin behave the same, use the context's permission helpers so denials come with an explanation, and add tests next to the existing ones.

### UI changes

Read `docs/DESIGN.md` first. Use the design tokens (`bg-surface`, `text-muted`, `border-line`, `text-accent`...) rather than raw Tailwind palette colors, and check both themes.

### Adding a module

Add it to `src/data/lpiModules.ts` or `src/data/windowsPbqs.ts`, with a one-sentence `summary` for the lab list. Verifiers receive the filesystem, system state and the last command (`CommandContext`: command, exit code, stdout). Check success and evidence in the output, not just the command text. Put the commands a student types in `solutionWalkthrough`, one per line; the replay test will tell you if they do not satisfy every objective.

## Deployment

The site is static (no server code), so it can be hosted anywhere that serves files. Two hosts are set up:

### Cloudflare Workers (static assets)

`wrangler.jsonc` describes a static-assets Worker named `terminalpractice` that serves `dist/`. Cloudflare Workers Builds is connected to this repository, so every push builds and deploys automatically: pushes to `main` go to production, and pull requests get a preview deployment with its own URL (posted on the PR by Cloudflare's bot).

- `npm run deploy` builds and deploys from your machine (`wrangler deploy`; run `npx wrangler login` once first).
- `npx wrangler dev` serves the built site locally through Cloudflare's runtime.
- `wrangler deploy` runs `npm run build` itself (the `build` section of `wrangler.jsonc`), so it never ships a stale `dist/`.
- Workers Builds settings in the Cloudflare dashboard: the deploy command is `npx wrangler deploy` (the default); no separate build command is needed. Node 22 comes from `.node-version`.

### GitHub Pages

Pushes to `main` also run `.github/workflows/deploy.yml`, which tests, builds and publishes `dist/` to GitHub Pages. One-time setup: in the repository settings, under **Pages**, set **Source** to **GitHub Actions**. The build uses a relative base path, so it works from a project URL such as `https://<user>.github.io/<repo>/`. If Cloudflare becomes the only host, delete that workflow and turn Pages off.

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build and the browser tests on every push and pull request.
