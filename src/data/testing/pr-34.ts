import type { TestNote } from './types';

const note: TestNote = {
  pr: 34,
  title: 'Checkpoint questions come in a new order on every attempt',
  steps: [
    'Open a checkpoint and note the first question.',
    'Finish it (any answers), then choose Try again: the order is different and every question is still there.',
  ],
  links: [{ label: 'LPIC-1 101, stage 1 checkpoint', href: '#/learn/lpic1-101' }],
};
export default note;
