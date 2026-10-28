import type { TestNote } from './types';

const note: TestNote = {
  pr: 54,
  title: 'Auto save: progress follows your account',
  steps: [
    'Signed out, the Auto save button at the top leads to sign-in.',
    'Finish a task in a lab while signed out, then sign in: Auto save is on, and that task is added to your account.',
    'Open the site in a private window and sign in to the same account: the same progress is there.',
    'Click Auto save to turn it off, finish another task, and check the private window: it does not appear until you turn Auto save back on.',
    'Sign out: the progress shown goes back to what this browser had before signing in.',
  ],
  links: [
    { label: 'Account', href: '#/account' },
    { label: 'Hardware lab', href: '#/linux/lpi-101-1-system-architecture' },
  ],
};
export default note;
