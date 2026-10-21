import test from 'node:test';
import assert from 'node:assert/strict';
import { getNodeAtPath } from './filesystem.ts';
import { linuxSession } from './testUtils.ts';
import { linuxCommands } from './linux/context.ts';
import { LINUX_DOCS, linuxCommandDoc, linuxNames } from './docs/index.ts';

test('docs: every registered Linux command has documentation', () => {
  const missing = linuxCommands.names().filter(n => !linuxCommandDoc(n));
  assert.deepEqual(missing, [], `commands without docs: ${missing.join(', ')}`);
  for (const d of LINUX_DOCS) {
    assert.ok(d.summary && d.synopsis.length && d.description.length, `${d.name} is missing a part`);
    assert.ok([1, 5, 8].includes(d.section));
  }
  // every alias a doc claims really is a command (page-only docs aside)
  for (const d of LINUX_DOCS.filter(x => !x.pageOnly)) {
    for (const n of linuxNames(d)) assert.ok(linuxCommands.has(n) || n === 'sudo' || n === 'dash', `${n} is documented but not registered`);
  }
});

test('man renders real-looking pages with the right sections', () => {
  const run = linuxSession();
  const ls = run('man ls');
  assert.equal(ls.exitCode, 0);
  const lines = ls.stdout.split('\n');
  assert.match(lines[0], /^LS\(1\) +User Commands +LS\(1\)$/);
  assert.equal(lines[0].length, 80);
  for (const h of ['NAME', 'SYNOPSIS', 'DESCRIPTION', 'OPTIONS', 'EXAMPLES', 'SEE ALSO']) assert.ok(lines.includes(h), `missing ${h}`);
  assert.ok(ls.stdout.includes('       ls - list directory contents'));
  assert.ok(ls.stdout.includes('       -a, --all'));

  assert.match(run('man useradd').stdout, /^USERADD\(8\)/);
  assert.match(run('man fdisk').stdout, /^FDISK\(8\) +System Administration/);
  // section 1 wins without a section; 5 asks for the file format
  assert.match(run('man passwd').stdout, /^PASSWD\(1\)/);
  const five = run('man 5 passwd');
  assert.match(five.stdout, /^PASSWD\(5\) +File Formats and Conversions/);
  assert.ok(five.stdout.includes('/etc/passwd'));
  assert.match(run('man -s 5 shadow').stdout, /^SHADOW\(5\)/);
  assert.match(run('man 5 fstab').stdout, /^FSTAB\(5\)/);
  assert.match(run('man egrep').stdout, /^GREP\(1\)/);

  const none = run('man nosuchthing');
  assert.equal(none.stderr, 'No manual entry for nosuchthing');
  assert.equal(none.exitCode, 16);
  assert.equal(run('man 8 ls').stderr, 'No manual entry for ls in section 8');
  assert.equal(run('man').exitCode, 1);
  // builtins have no page of their own: say so, and point at help
  const cd = run('man cd');
  assert.equal(cd.stderr, 'No manual entry for cd');
  assert.match(cd.explanation ?? '', /help cd/);
  assert.equal(run('man -w ls').stdout, '/usr/share/man/man1/ls.1.gz');
});

test('man -k / apropos and man -f / whatis', () => {
  const run = linuxSession();
  const k = run('man -k passwd');
  assert.equal(k.stdout, run('apropos passwd').stdout);
  assert.ok(k.stdout.split('\n').includes('passwd (1)           - change user password'));
  assert.ok(k.stdout.split('\n').includes('passwd (5)           - the password file'));
  assert.equal(run('whatis ls').stdout, 'ls (1)               - list directory contents');
  assert.equal(run('man -f ls').stdout, run('whatis ls').stdout);
  assert.equal(run('whatis passwd').stdout.split('\n').length, 2);
  const none = run('apropos qqqzz');
  assert.equal(none.stderr, 'qqqzz: nothing appropriate.');
  assert.equal(none.exitCode, 16);
  assert.equal(run('whatis nosuch').stderr, 'nosuch: nothing appropriate.');
  assert.match(run('apropos -s 8 user').stdout, /useradd \(8\)/);
  assert.doesNotMatch(run('apropos -s 8 user').stdout, /\(1\)/);
});

test('info shows Info nodes, falls back to man pages, and lists a directory', () => {
  const run = linuxSession();
  const ls = run('info ls');
  assert.equal(ls.exitCode, 0);
  assert.match(ls.stdout, /^File: coreutils\.info, {2}Node: ls invocation, {2}Next: dir invocation, {2}Up: Directory listing\n/);
  const grep = run('info grep');
  assert.match(grep.stdout, /^File: \*manpages\*, {2}Node: grep, {2}Up: \(dir\)\n\nGREP\(1\)/);
  const dir = run('info');
  assert.match(dir.stdout, /^File: dir/);
  assert.ok(dir.stdout.includes('* ls: (coreutils)ls invocation.'));
  assert.match(run('info coreutils').stdout, /Node: Top/);
  const none = run('info nosuchthing');
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /No menu item 'nosuchthing'/);
});

test('--help prints usage from the docs and does not run the command', () => {
  const run = linuxSession();
  const ls = run('ls --help');
  assert.equal(ls.exitCode, 0);
  assert.match(ls.stdout, /^Usage: ls \[OPTION\]\.\.\. \[FILE\]\.\.\.\n/);
  assert.match(ls.stdout, /\n {2}-a, --all +include entries/);
  assert.equal(run('chmod --help').exitCode, 0);
  assert.match(run('chmod --help').stdout, /^Usage: chmod/);

  // rm --help must not delete anything
  assert.ok(getNodeAtPath(run.fs(), '/home/student/notes.txt', false));
  const rm = run('rm --help notes.txt');
  assert.equal(rm.exitCode, 0);
  assert.ok(getNodeAtPath(run.fs(), '/home/student/notes.txt', false), 'rm --help deleted the file');
  // after --, --help is a file name again
  assert.match(run('rm -- --help').stderr, /cannot remove '--help'/);
  assert.match(run('sudo useradd --help').stdout, /^Usage: useradd/);
  assert.equal(run('/usr/bin/ls --help').stdout, ls.stdout);

  // -h is help only where the real tool says so
  assert.match(run('useradd -h').stdout, /^Usage: useradd/);
  assert.match(run('df -h').stdout, /Size +Used Avail/);
  assert.match(run('free -h').stdout, /Mem:/);
  const grepH = run('grep -h root /etc/passwd /etc/group');
  assert.doesNotMatch(grepH.stdout, /^\/etc\/passwd:/m);
  assert.match(grepH.stdout, /^root:x:0:0/m);

  // bash builtins answer --help with their help text; echo, true and false do not
  assert.match(run('cd --help').stdout, /^cd: cd \[-L/);
  assert.equal(run('echo --help').stdout, '--help');
  assert.equal(run('true --help').stdout, '');
});

test('help lists builtins and documents each one', () => {
  const run = linuxSession();
  const list = run('help');
  assert.match(list.stdout, /^GNU bash, version 5/);
  assert.match(list.stdout, /cd \[-L\|\[-P \[-e\]\] \[-@\]\] \[dir\]/);
  assert.match(list.stdout, /umask \[-p\] \[-S\] \[mode\]/);
  const cd = run('help cd');
  assert.match(cd.stdout, /^cd: cd \[-L\|\[-P \[-e\]\] \[-@\]\] \[dir\]\n {4}Change the shell working directory\./);
  assert.match(cd.stdout, /Exit Status:/);
  assert.equal(run('help -d umask').stdout, 'umask - Display or set file mode mask.');
  assert.equal(run('help -s type').stdout, 'type: type [-afptP] name [name ...]');
  assert.match(run('help ex').stdout, /^exit: exit \[n\][\s\S]*\nexport: export/);
  const none = run('help ls');
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /no help topics match `ls'/);
});

test('type, which and whereis agree', () => {
  const run = linuxSession();
  assert.equal(run('type ls').stdout, 'ls is /usr/bin/ls');
  assert.equal(run('which ls').stdout, '/usr/bin/ls');
  assert.equal(run('whereis ls').stdout, 'ls: /usr/bin/ls /usr/share/man/man1/ls.1.gz');
  assert.equal(run('type cd').stdout, 'cd is a shell builtin');
  assert.equal(run('which cd').exitCode, 1);
  assert.equal(run('whereis cd').stdout, 'cd:');
  assert.equal(run('type useradd').stdout, 'useradd is /usr/sbin/useradd');
  assert.equal(run('which useradd').stdout, '/usr/sbin/useradd');
  assert.match(run('whereis useradd').stdout, /^useradd: \/usr\/sbin\/useradd \/usr\/share\/man\/man8\/useradd\.8\.gz$/);
  assert.equal(run('type echo').stdout, 'echo is a shell builtin');
  assert.equal(run('which echo').stdout, '/usr/bin/echo');
  assert.equal(run('type -a echo').stdout, 'echo is a shell builtin\necho is /usr/bin/echo\necho is /bin/echo');
  assert.equal(run('type -t cd ls if').stdout, 'builtin\nfile\nkeyword');
  assert.equal(run('type -p ls').stdout, '/usr/bin/ls');
  assert.equal(run('type -P echo').stdout, '/usr/bin/echo');
  assert.equal(run('type sudo').stdout, 'sudo is /usr/bin/sudo');
  const none = run('type nosuch');
  assert.equal(none.stderr, 'bash: type: nosuch: not found');
  assert.equal(none.exitCode, 1);
  assert.match(run('whereis passwd').stdout, /\/etc\/passwd .*man1\/passwd\.1\.gz .*man5\/passwd\.5\.gz/);
});
