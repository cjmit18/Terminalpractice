# Terminus CertSim

A browser-based terminal simulator for IT certification practice. It runs entirely on the client: no server, no accounts, no API keys. It installs as an app on phones and desktops and works offline after the first visit.

Covers hands-on objectives for:
- **LPI Linux** (LPIC-1 101/102): permissions, text processing, system architecture, user administration, disk partitioning
- **CompTIA Windows PBQs** (A+, Network+, Security+ style): network troubleshooting, Active Directory, Group Policy, DiskPart, incident response, SFC/DISM, PowerShell

## What's in the app

- **13 guided lab modules** (5 Linux, 8 Windows). Each has a scenario, objectives that are checked against real simulated system state, hints, exam tips and a full walkthrough.
- **Terminal sandbox**: free-form Linux Bash, CMD and PowerShell sessions with a live view of the virtual filesystem.
- **System simulators**: interactive Active Directory, Group Policy, DiskPart, network topology and permission-matrix panels.
- **Command reference**: searchable list of exam-relevant commands.
- **Phone support**: single-pane lab layout, a key toolbar (`Tab`, `Ctrl+C`, arrows, and `| > < & / ~ - _ . $ * " ' \ :`) and an input configured so the keyboard does not autocorrect or capitalize commands.
- **Installable and offline**: web app manifest, icons and a service worker. Fonts are bundled, so nothing is fetched from third parties.

### Simulated command support

- **Linux:** `ls` (including `-l`, `-a`, `-d`), `cat`, `grep`, `awk`, `sed`, `sort`, `uniq`, `head`, `tail`, `wc`, `echo`, `tee`, `touch`, `mkdir -p`, `rm`, `chmod` (octal, symbolic, `-R`, SUID/SGID/sticky), `chown`, `umask`, `useradd`, `usermod -aG`, `id`, `tar`, `sudo`, `su`, `systemctl`, `journalctl`, `fdisk -l`, `df`, `lspci`, `lsmod`, `dmesg`, `ip`, `ps`, `kill`
- **Windows:** `ipconfig`, `ping`, `tracert`, `netstat`, `route print`, `tasklist`, `taskkill`, `gpupdate`, `gpresult`, interactive `diskpart`, `sfc`, `dism`, `net user`, `findstr`, plus PowerShell cmdlets such as `Get-Service`, `Start-Service`, `Get-Process` (with `Where-Object` using `-eq`, `-ne`, `-like`), `Test-NetConnection` and the Active Directory cmdlets used by the labs
- **Shell features:** pipes, `>` and `>>`, `2>`, `2>>`, `2>&1`, quote-aware parsing, `&&`, `||` and `;` in Bash, and `&`, `&&`, `||` in CMD

## Project layout

```
src/
├── terminal/
│   ├── parser.ts         # tokenizer, pipelines, command chaining, redirects
│   ├── filesystem.ts     # virtual POSIX/Windows filesystem and permission checks
│   ├── linuxEngine.ts    # Bash command execution
│   ├── windowsEngine.ts  # CMD and PowerShell execution, DiskPart subshell
│   └── rules.test.ts     # unit, regression and walkthrough replay tests
├── components/           # React UI: module runner, terminal view, simulators, sandbox
├── data/                 # lab modules, Windows PBQs, command reference
└── types/
public/                   # web app manifest, service worker, icons
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

### Adding a module

Add it to `src/data/lpiModules.ts` or `src/data/windowsPbqs.ts`. Verifiers receive the filesystem, system state and the last command (`CommandContext`: command, exit code, stdout). Check success and evidence in the output, not just the command text. Put the commands a student types in `solutionWalkthrough`, one per line; the replay test will tell you if they do not satisfy every objective.

## Deployment

Pushes to `main` run `.github/workflows/deploy.yml`, which tests, builds and publishes `dist/` to GitHub Pages. One-time setup: in the repository settings, under **Pages**, set **Source** to **GitHub Actions**. The build uses a relative base path, so it works from a project URL such as `https://<user>.github.io/<repo>/`.

CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push and pull request.
