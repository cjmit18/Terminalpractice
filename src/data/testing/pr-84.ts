import type { TestNote } from './types';

const note: TestNote = {
  pr: 84,
  title: 'Subnetting drills, a new tab on Challenges',
  steps: [
    'Open Challenges. Under the heading there are now two tabs: Challenges and Drills.',
    'Open Drills. It asks one subnetting question, for example the network address of 192.168.225.97/27.',
    'Type an answer and press Check (or Enter). It says Correct or Not quite, shows the answer and how it is worked out.',
    'Press Next question: a new question with new numbers. Reloading the page gives another new one.',
    'A prefix can be typed as /26 or 26, and a host count as 1,022 or 1022.',
    'Check with an empty box: it asks you to type an answer first and nothing is counted.',
  ],
  links: [
    { label: 'Drills', href: '#/sandbox/drills' },
    { label: 'Challenges', href: '#/sandbox/challenge' },
  ],
};
export default note;
