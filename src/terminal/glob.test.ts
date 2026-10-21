import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxSession } from './testUtils.ts';
import { tokenizeWords } from './parser.ts';

test('Globbing: the tokenizer marks only unquoted wildcards', () => {
  const words = tokenizeWords(`ls *.txt '*.txt' "a*" b\\*c d"*"e*`);
  assert.deepEqual(words.map(w => w.text), ['ls', '*.txt', '*.txt', 'a*', 'b*c', 'd*e*']);
  assert.equal(words[1].globPattern, '*.txt');
  assert.equal(words[2].globPattern, undefined);
  assert.equal(words[3].globPattern, undefined);
  assert.equal(words[4].globPattern, undefined);
  // Quoted star is literal, the trailing one is a wildcard
  assert.equal(words[5].globPattern, 'd[*]e*');
});

test('Globbing: bash expands *, ? and [...] against the filesystem, sorted', () => {
  const run = linuxSession();
  run('mkdir g && touch g/a.txt g/b.txt g/c.log g/.hidden.txt g/ab.txt');
  assert.equal(run('echo g/*.txt').stdout, 'g/a.txt g/ab.txt g/b.txt');
  assert.equal(run('echo g/?.txt').stdout, 'g/a.txt g/b.txt');
  assert.equal(run('echo g/[ac]*').stdout, 'g/a.txt g/ab.txt g/c.log');
  // Hidden files only match a pattern that starts with a dot
  assert.equal(run('echo g/.*.txt').stdout, 'g/.hidden.txt');
  // Relative to the current directory, absolute stays absolute
  run('cd g');
  assert.equal(run('echo *.log').stdout, 'c.log');
  assert.equal(run('echo /etc/pass*').stdout, '/etc/passwd');
  // Commands receive the expanded list
  run('rm *.txt');
  assert.equal(run('ls').stdout.trim(), 'c.log');
});

test('Globbing: no match, quotes and directory permissions behave like bash', () => {
  const run = linuxSession();
  // No match: the pattern is passed through, so the command sees it literally
  assert.equal(run('echo /nonexistent/*').stdout, '/nonexistent/*');
  assert.match(run('ls /tmp/*.none').stderr, /cannot access '\/tmp\/\*\.none'/);
  // Quoted patterns are never expanded
  assert.equal(run(`echo '/etc/pass*'`).stdout, '/etc/pass*');
  // A directory the user cannot read gives no matches (expansion runs before sudo, as the user)
  assert.equal(run('echo /root/*').stdout, '/root/*');
  // Directory-only patterns
  run('mkdir -p d1/sub && touch d1/file');
  assert.equal(run('echo d1/*/').stdout, 'd1/sub/');
});
