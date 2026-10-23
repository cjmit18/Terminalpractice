import type { TestNote } from './types';

const note: TestNote = {
  pr: 43,
  title: 'This testing page',
  steps: [
    'The strip at the top of every page links here.',
    '"In this build" lists the pull requests merged into this test site, and any left out because they conflict.',
  ],
  links: [{ label: 'Testing page', href: '#/testing' }],
};
export default note;
