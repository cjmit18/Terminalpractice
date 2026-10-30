import type { TestNote } from './types';

const note: TestNote = {
  pr: 57,
  title: 'Security and data page',
  steps: [
    'Sign in, open your account, then Open security and data.',
    'Sign in on a second browser or a private window: back here, the list under Where you’re signed in shows two sign-ins, this browser first.',
    'Sign out the other one: the private window is signed out on its next action.',
    'Change your password with a wrong current password first (the error shows under that field), then the right one.',
    'Download my data: a JSON file with your account and progress, and no password.',
    'On a throwaway account only: type delete, enter the password, and delete it. You are signed out and the account is gone.',
  ],
  links: [
    { label: 'Account', href: '#/account' },
    { label: 'Security and data', href: '#/account/security' },
  ],
};
export default note;
