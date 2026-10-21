import { LearningPath } from '../types/paths';

/**
 * Guided learning paths. Placeholder content: a short sample path so the UI can be built
 * against real data. The full paths replace this file.
 */
export const LEARNING_PATHS: LearningPath[] = [
  {
    id: 'lpic1-101',
    track: 'linux',
    title: 'Linux foundations',
    summary: 'Permissions, text processing and hardware basics for the first LPIC-1 exam.',
    exam: 'LPIC-1 101-500',
    audience: 'For people who can open a terminal but have not managed a Linux system yet.',
    stages: [
      {
        id: 'permissions',
        title: 'Who can do what',
        goal: 'Read and change file permissions and ownership with confidence.',
        steps: [
          {
            kind: 'lesson',
            id: 'reading-ls-l',
            title: 'Reading ls -l',
            minutes: 4,
            blocks: [
              { type: 'p', text: 'Every file has an owner, a group and three sets of permissions: one for the owner, one for the group and one for everyone else.' },
              { type: 'code', shell: 'bash', code: 'ls -l notes.txt\n-rw-r----- 1 student finance 120 Oct 19 10:00 notes.txt' },
              { type: 'table', columns: ['Characters', 'Meaning'], rows: [['rw-', 'Owner can read and write'], ['r--', 'Group can read'], ['---', 'Others have no access']] },
              { type: 'note', tone: 'exam', text: 'Use ls -ld to see a directory\'s own permissions instead of its contents.' },
            ],
          },
          { kind: 'lab', id: 'lab-permissions', moduleId: 'lpi-104-5-permissions', note: 'Lock down a folder using what you just read.' },
          {
            kind: 'quiz',
            id: 'check-permissions',
            title: 'Checkpoint: permissions',
            passMark: 0.5,
            questions: [
              {
                id: 'q-750',
                prompt: 'What does chmod 750 give the group?',
                choices: ['Read, write and execute', 'Read and execute', 'Read only', 'Nothing'],
                answer: 1,
                explanation: 'The middle digit is the group: 5 = 4 (read) + 1 (execute).',
              },
              {
                id: 'q-ld',
                prompt: 'Which command shows a directory\'s own permissions rather than its contents?',
                choices: ['ls -l dir', 'ls -ld dir', 'stat -c dir', 'ls -a dir'],
                answer: 1,
                explanation: '-d lists the directory itself; without it ls lists what is inside.',
              },
            ],
          },
        ],
      },
      {
        id: 'text',
        title: 'Finding things in text',
        goal: 'Filter log files with grep, awk, sort and uniq.',
        steps: [
          { kind: 'lab', id: 'lab-text', moduleId: 'lpi-103-2-text-processing' },
        ],
      },
    ],
  },
];
