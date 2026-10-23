import test from 'node:test';
import assert from 'node:assert/strict';
import { batchMessage } from './celebrate.ts';

test('Celebrations: one task, several tasks, badges and milestones become one message', () => {
  assert.equal(batchMessage([]), null);
  assert.deepEqual(batchMessage([{ kind: 'task', title: 'Set the mode to 750', index: 3, total: 4 }]), {
    text: 'Task 3 of 4 done: Set the mode to 750.',
    lines: ['Task 3 of 4 done: Set the mode to 750.'],
    lasting: false,
    confetti: false,
  });

  const walkthrough = batchMessage([
    { kind: 'task', title: 'Find the disk', index: 1, total: 3 },
    { kind: 'task', title: 'Read the partition table', index: 2, total: 3 },
    { kind: 'task', title: 'Find the disk', index: 1, total: 3 },
    { kind: 'milestone', text: 'Lab done: Disks' },
    { kind: 'badge', name: 'First lab', description: 'You finished every task in a lab.' },
  ]);
  assert.equal(
    walkthrough?.text,
    '2 tasks done: Find the disk; Read the partition table. Lab done: Disks. Badge earned: First lab. You finished every task in a lab.',
  );
  assert.equal(walkthrough?.lasting, true);

  const two = batchMessage([
    { kind: 'badge', name: 'whoami', description: 'You asked the machine who you are.' },
    { kind: 'badge', name: 'man man', description: 'You opened a manual page.' },
    { kind: 'milestone', text: 'Stage clear: Permissions', confetti: true },
  ]);
  assert.equal(two?.text, 'Stage clear: Permissions. 2 badges earned: whoami; man man.');
  assert.equal(two?.confetti, true);
  for (const m of [walkthrough, two]) assert.ok(!m?.text.includes('!'));
});

test('Celebrations: the note shows the biggest news first, then one item per line', () => {
  const finish = batchMessage([
    { kind: 'task', title: 'Ask for help', index: 5, total: 5 },
    { kind: 'milestone', text: 'Lab done: Your first commands in bash' },
    { kind: 'milestone', text: 'Stage clear: Your first terminal' },
    { kind: 'milestone', text: 'Path done: Your first terminal', confetti: true },
    { kind: 'badge', name: 'man man', description: 'You opened a manual page.' },
    { kind: 'badge', name: 'First lab', description: 'You finished every task in a lab.' },
  ]);
  assert.deepEqual(finish?.lines, [
    'Path done: Your first terminal!',
    'Stage clear: Your first terminal.',
    'Lab done: Your first commands in bash.',
    'Task 5 of 5 done: Ask for help.',
    '2 badges earned: man man, First lab.',
  ]);
  // A task on its own is one calm line
  assert.deepEqual(batchMessage([{ kind: 'task', title: 'Set the mode to 750', index: 3, total: 4 }])?.lines, ['Task 3 of 4 done: Set the mode to 750.']);
  assert.deepEqual(batchMessage([{ kind: 'badge', name: 'whoami', description: 'You asked.' }])?.lines, ['Badge earned: whoami.']);
});
