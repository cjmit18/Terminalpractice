import type { TestNote } from './types';

const note: TestNote = {
  pr: 35,
  title: '"Review complete!" at the end of a review round',
  steps: [
    'Answer a checkpoint, then come back later (or use a browser with older answers) and open Review.',
    'Answer every question: the last screen says "Review complete!" with no score.',
  ],
  links: [{ label: 'Review', href: '#/learn/review' }],
};
export default note;
