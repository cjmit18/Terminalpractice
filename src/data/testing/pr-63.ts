import type { TestNote } from './types';

const note: TestNote = {
  pr: 63,
  title: 'Add a way to sign in',
  steps: [
    'Signed in with email and a password, open Security and data: under Ways to sign in there is now Link GitHub.',
    'Enter your current password and choose Link GitHub. After GitHub, you are back here with GitHub in the list.',
    'Sign out, then sign in with GitHub: it opens the same account, and your display name is unchanged.',
    'Try linking a GitHub account that already has its own Terminus account: the page says why it was not linked.',
    'With an account made with GitHub, add an email and a password: a confirmation email arrives, and email sign-in works.',
  ],
  links: [{ label: 'Security and data', href: '#/account/security' }],
};
export default note;
