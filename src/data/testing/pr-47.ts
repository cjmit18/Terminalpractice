import type { TestNote } from './types';

const note: TestNote = {
  pr: 47,
  title: 'Commands in hints show as code, with their quotes',
  steps: [
    'In Your first commands on Windows, open the hints for "Read a file": type and type welcome.txt show in code font, and nothing says "type type".',
    'In Process text streams, open the hints for "Find the failed logins": the grep command keeps the quotes around Failed password.',
  ],
  links: [
    { label: 'Windows first steps', href: '#/learn/first-steps/lab-first-steps-windows' },
    { label: 'Text streams lab', href: '#/linux/lpi-103-2-text-processing' },
  ],
};
export default note;
