import type { TestNote } from './types';

const note: TestNote = {
  pr: 39,
  title: 'Lab tasks no longer accept a typed answer after a real command',
  steps: [
    'In the hardware lab, run: lspci > /dev/null; echo Ethernet. The "List the PCI devices" task stays open.',
    'Run lspci: the task passes.',
  ],
  links: [{ label: 'Hardware lab', href: '#/linux/lpi-101-1-system-architecture' }],
};
export default note;
