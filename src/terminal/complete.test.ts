import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLinuxFs, createDefaultWindowsFs } from './filesystem.ts';
import { completePath } from './complete.ts';

const linux = createDefaultLinuxFs();
const windows = createDefaultWindowsFs();
const home = '/home/student';

test('Tab completes a file or folder name: one match is finished, a folder gets a slash, a file a space', () => {
  assert.deepEqual(completePath(linux, home, 'no', false), { text: 'notes.txt ', names: ['notes.txt'] });
  assert.deepEqual(completePath(linux, home, 'scr', false), { text: 'scripts/', names: ['scripts'] });
  assert.deepEqual(completePath(linux, home, '/var/log/au', false), { text: '/var/log/auth.log ', names: ['auth.log'] });
  assert.deepEqual(completePath(linux, '/etc', '../var/l', false), { text: '../var/log/', names: ['log'] });
  assert.deepEqual(completePath(linux, '/', '~/no', false), { text: '~/notes.txt ', names: ['notes.txt'] });
  assert.deepEqual(completePath(linux, home, '~', false), { text: '~/', names: [] });
});

test('Tab with several matches extends to what they share and lists them; no match changes nothing', () => {
  // passwd and group share nothing, but /etc/ho... is hostname and hosts
  assert.deepEqual(completePath(linux, '/etc', 'ho', false), { text: 'host', names: ['hostname', 'hosts'] });
  assert.deepEqual(completePath(linux, '/etc', 'host', false), { text: 'host', names: ['hostname', 'hosts'] });
  assert.equal(completePath(linux, home, 'zzz', false), null);
  assert.equal(completePath(linux, home, 'missing/x', false), null);
  // A file is not a folder to complete inside
  assert.equal(completePath(linux, home, 'notes.txt/a', false), null);
});

test('Windows names complete without regard to case, keep their stored case, and folders get a backslash', () => {
  const cwd = 'C:\\Users\\Student';
  assert.deepEqual(completePath(windows, cwd, 'doc', true), { text: 'Documents\\', names: ['Documents'] });
  assert.deepEqual(completePath(windows, cwd, 'C:\\win', true), { text: 'C:\\Windows\\', names: ['Windows'] });
  assert.deepEqual(completePath(windows, cwd, '..\\stu', true), { text: '..\\Student\\', names: ['Student'] });
});
