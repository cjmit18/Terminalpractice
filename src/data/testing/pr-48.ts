import type { TestNote } from './types';

const note: TestNote = {
  pr: 48,
  title: 'rm -r respects permissions inside a folder',
  steps: [
    'In the Sandbox, run: mkdir protected; touch protected/data; chmod 500 protected',
    'Then rm -rf protected. It refuses: cannot remove protected/data, Permission denied. ls protected still shows data.',
    'chmod 700 protected, then rm -rf protected again: now it all goes.',
  ],
  links: [{ label: 'Sandbox', href: '#/sandbox' }],
};
export default note;
