import type { TestNote } from './types';

const note: TestNote = {
  pr: 40,
  title: 'The adm group challenge needs the real entry',
  steps: [
    "Open the challenge \"Who can read the logs\" and run: getent group adm | sed 's/syslog,student/root/'. It is not accepted.",
    'Run getent group adm: solved.',
  ],
  links: [{ label: 'Who can read the logs', href: '#/sandbox/challenge/bash-adm-group' }],
};
export default note;
