# Bug backlog

Unresolved, actionable bugs for an agent to pick up. Fix one item at a time, add a regression test, and check it off only after the test passes.

## Open

Nothing open here. Planned fixes from the scans, in order, are in [docs/PLAN.md](docs/PLAN.md).

## Done

- [x] **P1 — Bash applies `2>&1` as if it appeared after every stdout redirect**
  - **Location (when reported):** `src/terminal/parser.ts:135-145`, `src/terminal/linuxEngine.ts:125-165`. The Linux engine no longer parses bash with `parser.ts` (the engines use it for CMD and PowerShell): bash redirections now live in `src/terminal/linux/shell.ts` (`RedirOp`, `dupFrom`).
  - **Impact:** Redirection order changes where errors appear, so shell commands do not behave like bash.
  - **Reproduce:** Run `cat missing 2>&1 > /tmp/order-check`.
  - **Observed:** The error is written to `/tmp/order-check`, and nothing appears on the terminal.
  - **Expected:** `2>&1` duplicates stdout as it exists at that point; here the error stays on the terminal and `/tmp/order-check` is empty. The reverse order, `cat missing > /tmp/order-check 2>&1`, should write the error to the file.
  - **Acceptance:** Preserve redirection order and add regression tests for both command forms.
  - **Fixed:** the parser records whether `2>&1` follows a stdout redirect, and bash and CMD apply redirections left to right (including `2>&1 > file | cmd`). Tests: `src/terminal/redirectOrder.test.ts`.

- [x] **P2 — `npm test` omits most test files**
  - **Location:** `package.json:12`; test files under `src/`
  - **Impact:** CI's `npm test` command runs only `src/terminal/rules.test.ts`; the repository contains 12 `*.test.ts` files, leaving 11 out of the configured unit/regression test run.
  - **Expected:** The standard test command runs all repository `*.test.ts` tests, including the engine, journey, data, and regression suites.
  - **Acceptance:** Update the test command to discover/run all test files and verify CI's test step includes them.
  - **Fixed:** all files did run, but only through a hand-maintained import list in `rules.test.ts`. `npm test` now runs `tsx --test 'src/**/*.test.ts' 'worker/**/*.test.ts'`, so a new test file is picked up without being registered; CI calls `npm test` unchanged.
