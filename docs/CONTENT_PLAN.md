# Content plan: keeping Terminus CertSim fresh

Goal: learners find something new every visit, and the content gets a real refresh at least once a month, without big, hard-to-review pushes. Every change below ships as its own small PR.

Status: **started.** Content work runs alongside the login portal and the scan fixes (see [PLAN.md](PLAN.md)), in the order in [Build order](#build-order).

## 1. Content that varies on its own (built once)

These make the site feel new even between releases:

- **Generated drills:** subnetting, `chmod` numbers, port and protocol matching, and log reading.
  - Each round makes new numbers or log lines from a random seed.
  - The checker works the answer out from that seed, so there is no fixed answer key to memorise.
  - Subnetting drills are the subnetting practice CJ asked for (Network+ and LPIC-1 109.1).
- **Varied labs:** the same scenario with different usernames, IPs, failing services or attacker addresses each run.
  - Verifiers read the scenario's values, never hard-coded ones.
  - Convert one lab at a time.
- **Rotation:** there is no cap on how many questions or challenges exist or are shown, and every one stays active.
  - Challenges, new and old, live in one data file; the featured ones are swapped in at random.
  - Quiz and review questions stay in their pools; the order they appear in is rotated.
  - "Today's pick" and the spaced review queue already exist. New questions join the review queue once their checkpoint has been taken.

## 2. The weekly and monthly cycle

A scheduled task runs **every Monday at 5:00 AM America/Chicago**. `CRON_TZ=America/Chicago` follows daylight saving, so it is 5:00 local time in both CST and CDT. It starts a fresh session and opens one small PR. Nothing goes live until CJ reviews and merges it.

| Run | Contents |
|---|---|
| **First Monday of the month: monthly release** | 10–15 new quiz/review questions, aimed at the thinnest exam objectives. 2–3 new challenges (added to the pool, nothing removed). 1 new lab, or a new variant of an existing lab. A refresh of dated content: exam versions, tool changes, and last month's scan findings. A "What's new" entry. |
| **Other Mondays: light refresh** | 2–3 new questions or one challenge, plus small fixes from reviews or notes. If there's nothing worth adding, it reports that and opens no PR. |

**Themes** keep each monthly release focused. Pick the next month's theme in the previous release. For example:

| Month | Theme |
|---|---|
| November 2026 | Subnetting |
| December 2026 | Permissions and ACLs |
| January 2027 | Security+ exam update (check SY0-801 status) |
| February 2027 | Logs and troubleshooting |

## 3. Choosing what to add

1. **Coverage report.** A script (`scripts/coverage.ts`, to be built) lists each exam objective in `src/data/examObjectives.ts` with its count of questions, labs and challenges. The thinnest objectives get content first.
2. **Most-missed questions.** These come from the admin dashboard (login portal part 9), as anonymous totals from signed-in users who opt in only. Admin accounts are never counted. A question nearly everyone misses usually needs clearer wording, not more practice.
3. **CJ's notes** from studying: anything confusing or missing goes on the list for the next run.

## 4. Quality checks on every content PR

### Automatic, in `npm test` (to be built where missing)
- Every lab walkthrough and challenge solution passes its own checker.
- Listed near-miss answers fail.
- **Generated drills:** for many seeds, the computed answer matches an independent calculation.
- The correct choice is not the obvious "longest answer". This test exists already, with a 35% limit.
- Every command a question or lesson names runs in the simulator without "command not found".
- Tone rules from `docs/DESIGN.md`: calm wording, with exclamation marks only in the encouraging-copy exceptions it lists.

### Review
- One fact-checker agent reviews each content PR: real command behaviour, current exam objectives, and one defensible answer per question.
- Copilot review on the PR when quota allows.
- The **full five-checker scan** (questions, labs, structure, app, server), with a master re-check, runs every quarter and before any big feature.

## 5. The scheduled task (to set up in build step 4)

- **Schedule:** `CRON_TZ=America/Chicago 0 5 * * 1`: every Monday at 5:00 AM Chicago time, as CJ decided. An on-the-hour run may start a little late; that is fine.
- **Mode:** a fresh session each run, in an environment that has the `cjmit18/Terminalpractice` repository, the GitHub connector with push access (to open the PR) and the agent tool (for the fact-check).
- **Prompt, roughly:**
  1. Read `docs/CONTENT_PLAN.md` and run the coverage report.
  2. Decide whether it's the first Monday of the month, and pick monthly or light accordingly.
  3. Write the content on a new branch.
  4. Run lint, the tests, the build and the content tests.
  5. Fact-check the content with one checker agent.
  6. Open one small PR whose description lists what was added and why. Never merge.
- **Notifications:** push or email when the PR is ready.

## 6. "What's new" in the app

A small page, `#/whats-new`, linked from Learn. It lists each release by date with a one-line summary, and new questions get a quiet "New" tag for two weeks. It must stay calm: no counters, no streak pressure.

## Build order

Each step is its own small PR:

1. Coverage report script and the missing content-quality tests.
2. The "What's new" page.
3. Generated subnetting drills, which are also the subnetting feature.
4. The Monday scheduled task, as described in section 5.
5. Varied labs, one lab per PR.
6. Most-missed questions, after the admin dashboard (login portal part 9).

Alongside step 1: remove the 15-challenge cap from the tests and add the random challenge rotation, so monthly releases can add challenges.
