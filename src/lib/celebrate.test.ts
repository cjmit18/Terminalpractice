import test from 'node:test';
import assert from 'node:assert/strict';
import { batchMessage } from './celebrate.ts';

test('Celebrations: one task, several tasks, badges and milestones become one message', () => {
  assert.equal(batchMessage([]), null);
  assert.deepEqual(batchMessage([{ kind: 'task', title: 'Set the mode to 750', index: 3, total: 4 }]), {
    text: 'Task 3 of 4 done: Set the mode to 750.',
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
