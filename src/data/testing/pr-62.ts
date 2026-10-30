import type { TestNote } from './types';

const note: TestNote = {
  pr: 62,
  title: 'Most-missed questions',
  steps: [
    'Sign in with a learner account (not an admin) and open Security and data: "Share which questions I miss" is off.',
    'Turn it on, then take a checkpoint and get one question wrong on purpose.',
    'Sign in as the owner in a private window and open the Admin dashboard: that question is on the Most-missed list.',
    'Back on the learner account, turn sharing off: the note says your answers are deleted, and the list empties on refresh.',
    'Answers from your own account never count, since admins are left out of every total.',
  ],
  links: [
    { label: 'Security and data', href: '#/account/security' },
    { label: 'Admin dashboard', href: '#/admin' },
  ],
};
export default note;
