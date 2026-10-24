import type { TestNote } from '../data/testing/types';

/** Written by the test-site workflow next to index.html: which pull requests this build holds */
export interface BuildInfo {
  builtAt: string;
  main: string;
  included: { number: number; title: string; url: string }[];
  skipped: { number: number; title: string; url: string; reason: string }[];
}

/**
 * The notes for changes this build is known to hold: those whose pull request the workflow merged into
 * it. A note whose PR was skipped, or is no longer open, is left out: the builder only sees open pull
 * requests, so it cannot tell a PR merged into main from one closed without merging. (A merged change is
 * on the live site anyway.) Without build details (a local build) every note is shown.
 */
export function notesInBuild(notes: TestNote[], build: Pick<BuildInfo, 'included'> | null): TestNote[] {
  if (!build) return notes;
  const included = new Set(build.included.map(p => p.number));
  return notes.filter(n => included.has(n.pr));
}
