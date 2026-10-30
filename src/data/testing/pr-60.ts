import type { TestNote } from './types';

const note: TestNote = {
  pr: 60,
  title: 'Admin dashboard and view as',
  steps: [
    'First add OWNER_EMAIL (your own address) as a Secret on terminus-wm, and confirm that email on your account.',
    'Sign in: the account menu now has Admin dashboard. It shows totals of learner accounts, never yours.',
    'Add a second address of yours as an admin, sign in with it in a private window, and open the dashboard there too.',
    'View as a signed-out visitor: the header shows Sign in and a banner says what you are viewing as. Stop goes back.',
    'Sign in as a learner account: there is no Admin dashboard link, and #/admin says it is for admins.',
  ],
  links: [
    { label: 'Admin dashboard', href: '#/admin' },
    { label: 'Account', href: '#/account' },
  ],
};
export default note;
