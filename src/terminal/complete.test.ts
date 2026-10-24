import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultLinuxFs, createDefaultWindowsFs } from './filesystem.ts';
import { completeFileAt, completePath, wordBefore } from './complete.ts';
import { getNodeAtPath } from './filesystem.ts';
import { FileNode } from '../types/terminal.ts';

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

/** A copy of the file or folder at `from`, added beside it as `name` */
function addCopy(fs: FileNode, from: string, name: string, isWindows = false): FileNode {
  const sep = isWindows ? '\\' : '/';
  const dir = getNodeAtPath(fs, from.slice(0, from.lastIndexOf(sep)) || sep, isWindows)!;
  const copy = { ...structuredClone(getNodeAtPath(fs, from, isWindows)!), name };
  dir.children![name] = copy;
  return fs;
}

test('a name with a space is escaped in bash and quoted in Command Prompt and PowerShell, so the line still runs', () => {
  const fs = addCopy(createDefaultLinuxFs(), '/home/student/notes.txt', 'quarterly report.txt');
  addCopy(fs, '/home/student/scripts', 'old scripts');
  assert.deepEqual(completeFileAt(fs, home, 'cat qua', 7, 'bash'), { line: 'cat quarterly\\ report.txt ', caret: 26, names: ['quarterly report.txt'] });
  assert.deepEqual(completeFileAt(fs, home, 'cd old', 6, 'bash')?.line, 'cd old\\ scripts/');
  // A quote the learner opened is kept: closed after a file, left open after a folder so the path can go on
  assert.equal(completeFileAt(fs, home, 'cat "qua', 8, 'bash')?.line, 'cat "quarterly report.txt" ');
  assert.equal(completeFileAt(fs, home, "cd 'old", 7, 'bash')?.line, "cd 'old scripts/");
  // Already escaped or quoted words are read as the shell reads them
  assert.equal(completeFileAt(fs, home, 'cat quarterly\\ r', 16, 'bash')?.line, 'cat quarterly\\ report.txt ');
  assert.equal(completeFileAt(fs, home, 'cat "old scripts/b', 18, 'bash')?.line, 'cat "old scripts/backup.sh" ');

  const win = addCopy(createDefaultWindowsFs(), 'C:\\Users\\Student\\Documents', 'My Projects', true);
  const cwd = 'C:\\Users\\Student';
  assert.equal(completeFileAt(win, cwd, 'cd my', 5, 'cmd')?.line, 'cd "My Projects\\');
  assert.equal(completeFileAt(win, cwd, 'cd C:\\Users\\Student\\my', 22, 'cmd')?.line, 'cd "C:\\Users\\Student\\My Projects\\');
  assert.equal(completeFileAt(win, cwd, 'Get-ChildItem my', 16, 'powershell')?.line, "Get-ChildItem 'My Projects\\");
});

test('Tab completes the word at the caret and keeps the rest of the line', () => {
  const fs = createDefaultLinuxFs();
  // The caret just after "no", with another word after it
  assert.deepEqual(completeFileAt(fs, home, 'cat no /etc/ho', 6, 'bash'), { line: 'cat notes.txt  /etc/ho', caret: 14, names: ['notes.txt'] });
  assert.deepEqual(completeFileAt(fs, '/etc', 'cat ho notes.txt', 6, 'bash'), { line: 'cat host notes.txt', caret: 8, names: ['hostname', 'hosts'] });
  assert.deepEqual(wordBefore('cat "my fi', 10, 'bash'), { start: 4, text: 'my fi', quote: '"' });
  assert.deepEqual(wordBefore('cat a\\ b', 8, 'bash'), { start: 4, text: 'a b', quote: null });
  assert.deepEqual(wordBefore('dir "a b', 8, 'cmd'), { start: 4, text: 'a b', quote: '"' });
});
