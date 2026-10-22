import test from 'node:test';
import assert from 'node:assert/strict';
import { LEARNING_PATHS } from '../../data/paths.ts';
import { entryStatus, guideEntries, lessonCommandNames } from './catalog.ts';

test('Field guide: every documented command once per shell, each in a named area', () => {
  const entries = guideEntries();
  const keys = entries.map(e => `${e.shell}:${e.name}`);
  assert.equal(new Set(keys).size, keys.length);
  const other = entries.filter(e => e.area === 'Other').map(e => `${e.shell}:${e.name}`);
  assert.deepEqual(other, []);
  for (const e of entries) assert.ok(e.manual().length > 20, `${e.name} has a manual`);
});

test('Field guide: "seen" comes from the first word of lesson code lines; facts tick "ran" and "read"', () => {
  const seen = lessonCommandNames(LEARNING_PATHS);
  assert.ok(seen.has('bash:dmesg'));
  assert.ok(seen.has('bash:grep'), 'a command after a pipe counts');
  assert.ok(seen.has('bash:chown') && seen.has('bash:sudo'), 'sudo and the command it runs');
  const grep = guideEntries().find(e => e.shell === 'bash' && e.name === 'grep')!;
  assert.deepEqual(entryStatus(grep, new Set(['cmd:bash:egrep', 'help:linux:grep']), seen), { seen: true, ran: true, read: true });
  const gci = guideEntries().find(e => e.name === 'Get-ChildItem')!;
  assert.equal(entryStatus(gci, new Set(['cmd:ps:ls']), new Set()).ran, true);
  assert.equal(entryStatus(gci, new Set(['help:windows:dir']), new Set()).read, false, 'CMD help dir is the CMD page');
});
