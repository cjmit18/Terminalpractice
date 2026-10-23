# Terminus CertSim design guide

The goal: the app should feel like a well-made study tool built by a person who uses a terminal every day, closer to a printed lab manual next to a real shell than to a neon "hacker" dashboard. Every rule below exists to remove something that currently reads as generated.

## What we are removing

| Pattern | Why it reads as artificial | Replace with |
|---|---|---|
| A different accent color per tab or track (amber, blue, cyan, emerald, purple) | Decoration without meaning | One accent (`accent`) for interactive things. Track shown as a plain text label |
| Cards inside cards, every block bordered with a big radius | Template look, no hierarchy | Flat sections separated by spacing and a single `border-line` divider. At most one level of bordered container |
| Monospace used for labels, counters and badges | Fake "techy" flavour | Monospace only for things a user types or a machine prints: commands, paths, file names, output, flags |
| Pill badges everywhere (`TOPIC 104.5` twice, `0/4`, `Complete`) | Noise | Plain text. One small badge only when it carries state (e.g. Done) |
| Hype copy: "Security Audit Warning:", "Live Command & State Verification", "Exam Trap & Scoring Advice", "high-fidelity", "official certification objective" | Marketing voice | Plain, specific, second person (see Copy) |
| Fake window chrome: traffic-light dots, "CRT Scan", version banners | Costume | A simple terminal tab bar: shell name and host |
| 10–11px text as the default | Hard to read, looks crammed | Body 15px, secondary 13px, smallest 12px (labels only) |
| Icons on every button and heading | Clutter | Icons only where they help recognition (nav, status, copy, reset) |
| Gradients, glows, shadows, `backdrop-blur` | Decoration | Flat surfaces. One subtle shadow allowed on popovers |

## Tokens

Defined in `src/index.css` and exposed to Tailwind. Use these, not raw palette classes (`slate-*`, `cyan-*`, `amber-*`, `emerald-*`, `purple-*`, `rose-*`, `blue-*`).

| Tailwind | Use |
|---|---|
| `bg-bg` | Page background |
| `bg-surface` | Panels, the one level of container |
| `bg-surface-2` | Hover, selected rows, inline code background |
| `border-line` / `border-line-strong` | Dividers / input borders |
| `text-text` / `text-muted` / `text-subtle` | Primary / secondary / tertiary text |
| `text-accent`, `bg-accent text-accent-fg`, `bg-accent-soft` | Links and primary buttons / selected states |
| `ok`, `warn`, `danger` (+ `-soft`) | Status only: done, hint or caution, error |
| `term-*` | Terminal only (always dark): `bg-term-bg`, `bg-term-bar`, `text-term-text`, `text-term-muted`, `text-term-user`, `text-term-path`, `text-term-error`, `border-term-line` |

Light and dark themes are both supported. The page follows the OS; the user can override it (stored in `localStorage` as `certsim:theme`, applied as `data-theme` on `<html>`). Never hard-code a color that only works in one theme. The terminal stays dark in both.

Radius: `rounded-md` (6px) for controls and panels, `rounded-sm` for small tags. No `rounded-xl`/`rounded-2xl`.

## Type

- Fonts: IBM Plex Sans for UI, IBM Plex Mono for commands and output (bundled, no network).
- Scale: page title `text-2xl font-semibold`, section heading `text-base font-semibold`, body `text-[15px]`, secondary `text-sm` (13–14px), labels `text-xs` (12px) and only for labels.
- Weights: 400 body, 500 for emphasis and buttons, 600 for headings. No 700/800, no `tracking-tight` on body text, no `uppercase tracking-wider` labels except tiny table headers.
- Line length: prose capped at about 70ch (`max-w-prose`).

## Layout

- Spacing on a 4px grid; generous vertical rhythm between sections (`space-y-6` and up), tight inside a group.
- Desktop lab view: instructions on the left (reads like a document), terminal on the right. Phone: one pane at a time with a two-option switch.
- Navigation: one row. Current page shown by text color plus an underline or a subtle `bg-surface-2`, not a colored pill.
- Touch targets at least 40px tall on phones.

## Copy

- Second person, present tense, specific. "The finance folder is readable by everyone. Lock it down so only root and the finance group can get in." not "Security Audit Warning: ...".
- Headings say what is there: "Your tasks", "Hints", "Walkthrough", "Exam tips". Not "Task Objectives Checklist", "Exam Trap & Scoring Advice".
- No "seamless", "robust", "high-fidelity", "enterprise-grade", "live", "interactive" as filler.
- Exclamation marks only for earned encouragement: finishing a review, a lab, a challenge, a stage or a goal, or a correct answer ("Review complete!", "Nice work!"). One short phrase, never in instructions, errors, headings or buttons.
- Counts as words: "2 of 4 done", not "50% Verified".
- Buttons are verbs: "Run", "Reset lab", "Show hint", "Copy".

## Accessibility

- Text contrast at least 4.5:1 against its background in both themes (`text-subtle` only for non-essential text at 13px+).
- Every icon-only button has an `aria-label`.
- Terminal output region is `role="log"` with `aria-live="polite"`.
- Focus ring is the global `:focus-visible` outline; do not remove outlines.
- Respect `prefers-reduced-motion` (already global). No decorative animation.
