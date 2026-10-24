import type { TestNote } from '../data/testing/types';

/** Written by the test-site workflow next to index.html: which pull requests this build holds */
export interface BuildInfo {
  builtAt: string;
  main: string;
  included: { number: number; title: string; url: string }[];
  skipped: { number: number; title: string; url: string; reason: string }[];
}

/**
 * The notes for changes this build really has. The workflow merges every open pull request it can, so a
 * note's PR is in the build when it was included, left out when it was skipped (the build section says
 * why), and otherwise no longer open: merged into main, which every build starts from. Without build
 * details (a local build) every note is shown.
 */
export function notesInBuild(notes: TestNote[], build: Pick<BuildInfo, 'included' | 'skipped'> | null): { note: TestNote; inMain: boolean }[] {
  if (!build) return notes.map(note => ({ note, inMain: false }));
  const included = new Set(build.included.map(p => p.number));
  const skipped = new Set(build.skipped.map(p => p.number));
  return notes.filter(n => !skipped.has(n.pr)).map(note => ({ note, inMain: !included.has(note.pr) }));
}
