import type { TestNote } from './types';

const note: TestNote = {
  pr: 64,
  title: 'Settings page',
  steps: [
    'The header now has a gear icon instead of the theme buttons and Auto save. It opens Settings from any page.',
    'Settings has the theme, a new terminal text size, story notes, the weekly goal, badges and celebrations, your Sandbox machine, Auto save and clearing badges.',
    'Choose Large text, then open the Sandbox or a lab: the terminal text is bigger. It stays after a reload.',
    'The end of the Learn page now links to Settings instead of showing the settings there.',
    'Signed in, turn Auto save off and on in Settings; the status line says how the last sync went.',
  ],
  links: [
    { label: 'Settings', href: '#/settings' },
    { label: 'Sandbox', href: '#/sandbox' },
  ],
};
export default note;
