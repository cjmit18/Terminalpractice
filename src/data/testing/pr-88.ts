import type { TestNote } from './types';

const note: TestNote = {
  pr: 88,
  title: 'Drills: two tries, a hint and Skip',
  steps: [
    'Open Challenges, then Drills, and type a wrong answer: it says "Not quite. Try once more." and shows a hint. The answer stays hidden.',
    'Fix it and press Check again. Right: "Correct, on the second try." Wrong again: the answer and how it is worked out.',
    'Before answering, press "Show a hint" to see the hint without a miss.',
    'Press "Skip this question" for a new one; a skipped question is not counted in "right this visit".',
    'Both drills, Subnetting and Ports and protocols, work the same way.',
  ],
  links: [{ label: 'Drills', href: '#/sandbox/drills' }],
};
export default note;
