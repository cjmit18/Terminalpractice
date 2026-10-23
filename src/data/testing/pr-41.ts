import type { TestNote } from './types';

const note: TestNote = {
  pr: 41,
  title: 'Celebration note: a headline and one item per line',
  steps: [
    'Finish a lab (Your first terminal is quickest). The note shows "Lab done: …!" first, then one line per item.',
    'On a wide screen the note sits above the green Continue bar, not on top of it.',
  ],
  links: [{ label: 'Your first commands in bash', href: '#/learn/first-steps/lab-first-steps-linux' }],
};
export default note;
