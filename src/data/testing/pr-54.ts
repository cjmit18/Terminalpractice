import type { TestNote } from './types';

const note: TestNote = {
  pr: 54,
  title: 'Progress syncs with your account',
  steps: [
    'Signed out, finish a task in a lab. Then sign in: your account page asks whether to add this browser’s progress. Choose Add.',
    'Finish another task. On the account page, Your progress says it synced (Sync now does it at once).',
    'Open the site in another browser or a private window, sign in to the same account: the same progress is there.',
    'Sign out: the progress shown goes back to what this browser had before signing in.',
  ],
  links: [
    { label: 'Account', href: '#/account' },
    { label: 'Hardware lab', href: '#/linux/lpi-101-1-system-architecture' },
  ],
};
export default note;
