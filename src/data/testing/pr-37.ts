import type { TestNote } from './types';

const note: TestNote = {
  pr: 37,
  title: 'Offline copy no longer deletes other apps\' caches',
  steps: [
    'Load the site, then go offline (or turn on airplane mode) and reload: the app still opens.',
    'Nothing to see otherwise; the automatic test covers other apps on the same address.',
  ],
  links: [{ label: 'Linux labs', href: '#/linux' }],
};
export default note;
