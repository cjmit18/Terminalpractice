import type { TestNote } from './types';

const note: TestNote = {
  pr: 87,
  title: 'Ports and protocols drill, for Network+',
  steps: [
    'Open Challenges, then the Drills tab. Under "Drill", choose Ports and protocols.',
    'It asks one of three kinds: which port a protocol uses, which protocol uses a port, or TCP, UDP or both.',
    'Try "Which two ports does FTP use?": 20/21, 21 20 or 20 and 21 all count, but 21 alone does not. Port 22 takes SSH or SFTP.',
    'Check and Next question work as in Subnetting. Switching drills starts the other one fresh.',
  ],
  links: [{ label: 'Drills', href: '#/sandbox/drills' }],
};
export default note;
