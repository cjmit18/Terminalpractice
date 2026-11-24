import type { TestNote } from './types';

const note: TestNote = {
  pr: 90,
  title: 'Page headers on a phone: the buttons move below the title',
  steps: [
    'On a phone, open Sandbox. "Sandbox" and its description sit on their own lines, and Challenges, Your machine, Files and Reset sit in a row below them. Nothing overlaps and the description is not one word a line.',
    'Finish any lab first to see "Your machine" too: that is the widest the row gets.',
    'Open a lab and a challenge on the phone: their headers wrap the same way.',
    'On a computer, the buttons stay on the same line as the title, as before.',
  ],
  links: [
    { label: 'Sandbox', href: '#/sandbox' },
    { label: 'Labs', href: '#/labs' },
  ],
};
export default note;
