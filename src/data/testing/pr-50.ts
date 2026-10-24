import type { TestNote } from './types';

const note: TestNote = {
  pr: 50,
  title: 'Sign in and create an account',
  steps: [
    'Click Sign in at the top. The page offers email and password (and GitHub if it is set up here).',
    'Open Create account, leave everything empty and press Create account: each field says what it needs.',
    'Create an account. You land on "Hello, <your name>", with a note about confirming your email, and the menu at the top shows you.',
    'Sign out from the account page, then sign back in with the same email and password.',
  ],
  links: [{ label: 'Account', href: '#/account' }],
};
export default note;
