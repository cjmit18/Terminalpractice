import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxSession } from './testUtils.ts';
import { linuxCommands } from './linux/context.ts';
import { getNodeAtPath } from './filesystem.ts';
import { LAB_DATE, LAB_DAY, MS_PER_DAY, labNow } from './labClock.ts';

// Round-2 fact-check, package A: the Linux engine compared with real bash 5 / coreutils

// ---------- A2: depth caps and the internal-error guard ----------

test('A2: a 2000-deep $(( )) fails with bash\'s recursion message instead of throwing', () => {
  const run = linuxSession();
  const expr = '('.repeat(2000) + '1' + ')'.repeat(2000);
  const res = run(`echo $((${expr}))`);
  assert.equal(res.exitCode, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^bash: .*: expression recursion level exceeded \(error token is ".*"\)$/);
  // A long unary chain is capped the same way
  assert.match(run(`echo $((${'- '.repeat(2000)}1))`).stderr, /expression recursion level exceeded/);
  // Ordinary nesting still works
  assert.equal(run('echo $(( ((1+2)) * (3) ))').stdout, '9');
});

test('A2: mkdir -p 3000 deep is refused quickly and the session survives', () => {
  const run = linuxSession();
  const t0 = Date.now();
  const res = run('mkdir -p ' + Array(3000).fill('d').join('/'));
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /^mkdir: cannot create directory 'd\/d\/.*': File name too long$/);
  assert.equal(getNodeAtPath(run.fs(), '/home/student/d', false), null);
  assert.equal(run('pwd').stdout, '/home/student');
  assert.equal(run('ls -d scripts').stdout, 'scripts');
  // Up to the cap is fine
  assert.equal(run('mkdir -p ' + Array(200).fill('d').join('/')).exitCode, 0);
  // cp -r / mv that would go past the cap are refused too
  run('mkdir -p ' + Array(100).fill('e').join('/'));
  const cp = run('cp -r d ' + Array(100).fill('e').join('/'));
  assert.equal(cp.exitCode, 1);
  assert.match(cp.stderr, /File name too long/);
  const mv = run('mv d ' + Array(100).fill('e').join('/'));
  assert.equal(mv.exitCode, 1);
  assert.match(mv.stderr, /^mv: cannot move 'd' to .*: File name too long$/);
  assert.ok(getNodeAtPath(run.fs(), '/home/student/d', false));
});

test('A2: an exception inside a command becomes "internal error" and changes nothing', () => {
  linuxCommands.register('__boom', ctx => {
    ctx.fs.children = {};
    throw new Error('kaboom');
  });
  const run = linuxSession();
  run('cd scripts');
  const before = run.fs();
  const res = run('touch made.txt; __boom');
  assert.equal(res.exitCode, 1);
  assert.equal(res.stderr, 'bash: internal error: kaboom');
  assert.equal(res.newFs, before);
  assert.equal(run.cwd(), '/home/student/scripts');
  assert.equal(run('pwd').stdout, '/home/student/scripts');
  assert.match(run('ls /home/student').stdout, /scripts/);
});

// ---------- A1: ls when stdout is not the terminal ----------

test('A1: ls prints one name per line into a pipe, a file or $(...), columns at the terminal', () => {
  const run = linuxSession();
  assert.equal(run('ls').stdout, 'finance  notes.txt  scripts');
  assert.equal(run('ls | wc -l').stdout, '3');
  assert.equal(run('ls /etc | grep pass').stdout, 'passwd');
  run('ls > o.txt');
  assert.equal(run('cat o.txt').stdout, 'finance\nnotes.txt\no.txt\nscripts');
  assert.equal(run('echo "$(ls)"').stdout, 'finance\nnotes.txt\no.txt\nscripts');
  // -C forces columns; ls in a script run at the prompt still writes to the terminal
  assert.equal(run('ls -C | cat').stdout, 'finance  notes.txt  o.txt  scripts');
  run('echo ls > l.sh; chmod +x l.sh');
  assert.equal(run('./l.sh').stdout, 'finance  l.sh  notes.txt  o.txt  scripts');
  assert.equal(run('./l.sh | head -1').stdout, 'finance');
});

// ---------- A3: syntax errors (texts from bash 5.2) ----------

test('A3: syntax errors stop the whole line with bash\'s message and status 2', () => {
  const run = linuxSession();
  const cases: [string, string][] = [
    ['echo $(echo', "bash: unexpected EOF while looking for matching `)'"],
    ['echo `x', "bash: unexpected EOF while looking for matching ``'"],
    ["echo 'x", "bash: unexpected EOF while looking for matching `''"],
    ['echo "x', "bash: unexpected EOF while looking for matching `\"'"],
    ['echo ${HOME', "bash: unexpected EOF while looking for matching `}'"],
    ['|', "bash: syntax error near unexpected token `|'"],
    [';', "bash: syntax error near unexpected token `;'"],
    ['echo a && && echo b', "bash: syntax error near unexpected token `&&'"],
    ['echo a ;; echo b', "bash: syntax error near unexpected token `;;'"],
    ['echo a | | b', "bash: syntax error near unexpected token `|'"],
    ['echo a > ;', "bash: syntax error near unexpected token `;'"],
    ['echo a >', "bash: syntax error near unexpected token `newline'"],
    ['echo $(echo ))', "bash: syntax error near unexpected token `)'"],
    ['echo a |', 'bash: syntax error: unexpected end of file'],
    ['echo a &&', 'bash: syntax error: unexpected end of file'],
  ];
  for (const [line, err] of cases) {
    const res = run(line);
    assert.equal(res.stdout, '', line);
    assert.equal(res.stderr, err, line);
    assert.equal(res.exitCode, 2, line);
  }
  assert.equal(run('echo $?').stdout, '2');
  // Nothing on a line with a syntax error runs, not even the part before it
  run('touch before.txt; echo a && && echo b');
  assert.equal(run('ls before.txt').exitCode, 2);
  // Valid lines with quotes, substitutions, comments and redirections still run
  assert.equal(run('echo "$(echo "a b")" `echo c` $((1+(2))) \'x;y\' e\\;f # | ;;').stdout, 'a b c 3 x;y e;f');
  assert.equal(run('echo a; echo b &').stdout, 'a\nb');
});

// ---------- A5: unknown options (texts from coreutils 9 / GNU grep 3) ----------

test('A5: an unknown option stops the command before it does anything', () => {
  const run = linuxSession();
  run('touch h');
  let res = run('rm -Q h');
  assert.equal(res.exitCode, 1);
  assert.equal(res.stderr, "rm: invalid option -- 'Q'\nTry 'rm --help' for more information.");
  assert.equal(run('ls h').stdout, 'h');
  res = run('rm --bogus h');
  assert.equal(res.exitCode, 1);
  assert.equal(res.stderr, "rm: unrecognized option '--bogus'\nTry 'rm --help' for more information.");
  assert.equal(run('ls h').stdout, 'h');
  res = run('ls --hlep');
  assert.equal(res.exitCode, 2);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, "ls: unrecognized option '--hlep'\nTry 'ls --help' for more information.");
  res = run('grep -Q x notes.txt');
  assert.equal(res.exitCode, 2);
  assert.equal(res.stderr, "grep: invalid option -- 'Q'\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.");
  assert.equal(run('sort -Q notes.txt').exitCode, 2);
  assert.equal(run('mkdir -Q dd').exitCode, 1);
  assert.equal(run('ls dd').exitCode, 2);
  assert.equal(run('cp -Q h h2').exitCode, 1);
  assert.equal(run('ls h2').exitCode, 2);
  assert.equal(run('chmod -Q 600 h').stderr, "chmod: invalid option -- 'Q'\nTry 'chmod --help' for more information.");
  assert.equal(run('head -n').stderr, "head: option requires an argument -- 'n'\nTry 'head --help' for more information.");
  assert.equal(run('sort --key').stderr, "sort: option '--key' requires an argument\nTry 'sort --help' for more information.");
  assert.match(run('ls --s').stderr, /^ls: option '--s' is ambiguous; possibilities: /);
  assert.equal(run('sudo rm -Q h').exitCode, 1);
  assert.equal(run('ls h').stdout, 'h');
});

test('A5: valid options, including combined, numeric, valued and abbreviated ones, still work', () => {
  const run = linuxSession();
  assert.match(run('ls -la').stdout, /^total \d+\ndrwx/);
  run('mkdir -p d/e');
  assert.equal(run('rm -rf d').exitCode, 0);
  assert.equal(run('ls d').exitCode, 2);
  assert.equal(run('printf "3\\n1\\n2\\n" | sort -nr').stdout, '3\n2\n1');
  assert.equal(run('sort -t: -k3n /etc/passwd | head -1').stdout, 'root:x:0:0:root:/root:/bin/bash');
  assert.equal(run('head -1 notes.txt').stdout, 'LPIC-1 Study Notes:');
  assert.equal(run('tail -n +2 notes.txt | head -n1').stdout, '- Remember: chmod 755 gives rwxr-xr-x');
  assert.equal(run('chmod -w notes.txt').exitCode, 0);
  assert.match(run('ls -l notes.txt').stdout, /^-r--r--r-- /);
  assert.equal(run('ls --rec scripts').stdout.split('\n')[0], 'scripts:');
  assert.equal(run('ls --color=auto -C').stdout, 'finance  notes.txt  scripts');
});

test('A5: cat -A / -E / -T / -s / -b show what is in the file', () => {
  const run = linuxSession();
  assert.equal(run('cat -A /etc/hostname').stdout, 'lpi-lab01$');
  assert.equal(run('printf "a\\tb\\n\\n\\nc\\n" | cat -sbT').stdout, '     1\ta^Ib\n\n     2\tc');
  assert.equal(run('printf "x\\ty\\n" | cat -E').stdout, 'x\ty$');
});

// ---------- A6: journalctl -k and dmesg -T ----------

test('A6: journalctl -k shows the kernel ring buffer; dmesg -T prints wall-clock times', () => {
  const run = linuxSession();
  const sata = run('journalctl -k | grep -i sata');
  assert.equal(sata.exitCode, 0);
  assert.equal(sata.stdout, 'Oct 19 08:00:01 lpi-lab01 kernel: ahci 0000:00:1f.2: AHCI 0001.0000 32 slots 6 ports 1.5 Gbps 0x3f impl SATA mode');
  // Same lines for --dmesg and -b -k, and every kernel line of dmesg appears in the journal
  assert.equal(run('journalctl --dmesg').stdout, run('journalctl -k').stdout);
  assert.equal(run('journalctl -b -k').stdout, run('journalctl -k').stdout);
  const kernel = run('journalctl -k').stdout.split('\n').slice(1);
  assert.equal(kernel.length, run('dmesg').stdout.split('\n').length);
  assert.ok(kernel.every(l => / lpi-lab01 kernel: /.test(l)));
  assert.match(run('journalctl').stdout, /^-- Journal begins at Mon 2026-10-19 08:00:00 UTC, ends at Mon 2026-10-19 10:25:00 UTC\. --\nOct 19 08:00:00 lpi-lab01 kernel: Linux version/);
  assert.equal(run('dmesg -T | grep ahci').stdout, '[Mon Oct 19 08:00:01 2026] ahci 0000:00:1f.2: AHCI 0001.0000 32 slots 6 ports 1.5 Gbps 0x3f impl SATA mode');
  assert.match(run('dmesg').stdout, /^\[ {4}0\.000000\] Linux version/);
  // The journal is volatile in the lab, so there is no previous boot
  assert.equal(run('journalctl -b -1').stderr, 'Specifying boot ID or boot offset has no effect, no persistent journal was found.');
  assert.match(run('systemctl status ssh').stdout, /since Mon 2026-10-19/);
});

// ---------- A7: /etc/skel, useradd defaults, adduser ----------

test('A7: useradd -m copies /etc/skel; the defaults files exist; adduser is not simulated', () => {
  const run = linuxSession();
  assert.equal(run('ls -A /etc/skel').stdout, '.bash_logout  .bashrc  .profile');
  assert.equal(run('sudo useradd -m sarah').exitCode, 0);
  const home = run('sudo ls -a /home/sarah');
  assert.equal(home.stdout, '.  ..  .bash_logout  .bashrc  .profile');
  assert.match(run('sudo ls -la /home/sarah').stdout, /^-rw-r--r-- 1 sarah sarah +\d+ .* \.profile$/m);
  assert.match(run('ls -ld /home/sarah').stdout, /^drwxr-x--- \d+ sarah sarah /);
  assert.equal(run('sudo cat /home/sarah/.profile').stdout, run('cat /etc/skel/.profile').stdout);
  // Without -m there is no home directory (Ubuntu does not set CREATE_HOME)
  run('sudo useradd tom');
  assert.equal(run('ls /home/tom').exitCode, 2);
  const uidMin = run('grep UID_MIN /etc/login.defs');
  assert.equal(uidMin.exitCode, 0);
  assert.match(uidMin.stdout, /^UID_MIN\s+1000$/m);
  assert.match(run('grep -E "^(PASS_MAX_DAYS|UMASK|HOME_MODE)" /etc/login.defs').stdout, /PASS_MAX_DAYS\t99999[\s\S]*UMASK\t\t022|UMASK\t\t022[\s\S]*PASS_MAX_DAYS\t99999/);
  assert.equal(run('grep -c CREATE_HOME /etc/login.defs').stdout, '0');
  assert.equal(run('grep -v "^#" /etc/default/useradd').stdout, 'SHELL=/bin/sh');
  const add = run('adduser x');
  assert.equal(add.exitCode, 127);
  assert.equal(add.stderr, 'bash: adduser: this command exists on real systems but is not simulated here');
  assert.match(add.explanation ?? '', /useradd -m/);
});

// ---------- A4: parameter expansion (outputs from bash 5.2) ----------

test('A4: ${...} operators: length, substrings, trimming, replacement, case, nested defaults', () => {
  const run = linuxSession();
  assert.equal(run('echo ${HOME:0:5}').stdout, '/home');
  assert.equal(run('echo ${HOME#/home/}').stdout, 'student');
  assert.equal(run('echo ${HOME%/student}').stdout, '/home');
  assert.equal(run('echo ${HOME/student/x}').stdout, '/home/x');
  assert.equal(run('echo ${x:-${y:-${z:-deep}}}').stdout, 'deep');
  assert.equal(run('echo ${#HOME}').stdout, '13');
  assert.equal(run('echo ${HOME^^} ${HOME,,}').stdout, '/HOME/STUDENT /home/student');
  run('x=abcabc');
  assert.equal(run('echo ${x//b/Y} ${x/#a/S} ${x/%c/E} ${x:2} ${x: -2} ${x:1:-1} ${x##*b} ${x%%b*} ${x^} ${x#*b} ${x%b*}').stdout,
    'aYcaYc Sbcabc abcabE cabc bc bcab c a Abcabc cabc abca');
  assert.equal(run('echo ${x/b} ${x//[ab]/-} ${x/*/Z} ${x:(-3):2} ${x:10} ${x/"b"/\'Q\'}').stdout, 'acabc --c--c Z ab aQcabc');
  run('f=archive.tar.gz');
  assert.equal(run('echo ${f%.*} ${f%%.*} ${f#*.} ${f##*.}').stdout, 'archive.tar archive tar.gz gz');
  run('p=/usr/local/bin/tool');
  assert.equal(run('echo ${p##*/} ${p%/*}').stdout, 'tool /usr/local/bin');
  assert.equal(run('echo "${UNSET-default value}" ${UNSET:+alt} ${HOME:+alt}').stdout, 'default value alt');
  assert.equal(run('y=; echo "[${y-set}]" "[${y:-empty}]"').stdout, '[] [empty]');
  assert.equal(run('echo ${q:=assigned}; echo $q').stdout, 'assigned\nassigned');
  assert.equal(run('n=HOME; echo ${!n}').stdout, '/home/student');
  assert.equal(run('s="hello world"; echo ${s^} ${s@U} ${s@Q}').stdout, "Hello world HELLO WORLD 'hello world'");
});

test('A4: anything else is a bad substitution (status 1, the command does not run)', () => {
  const run = linuxSession();
  for (const body of ['${}', '${HOME@}', '${1x}', '${HOME;x}']) {
    const res = run(`touch made; echo ${body}`);
    assert.equal(res.stdout, '', body);
    assert.equal(res.stderr, `bash: ${body}: bad substitution`, body);
    assert.equal(res.exitCode, 1, body);
  }
});

// ---------- A9: smaller fixes ----------

test('A9: the lab clock: date, new files and new home directories are on Mon 19 Oct 2026', () => {
  const run = linuxSession();
  assert.match(run('date').stdout, /^Mon Oct 19 10:2\d:\d\d UTC 2026$/);
  assert.equal(run('date +%F').stdout, '2026-10-19');
  run('touch a; mkdir b; sudo useradd -m kim');
  assert.match(run('ls -ld a b /home/kim').stdout, /^drwxr-x--- .* Oct 19 10:2\d \/home\/kim\n-rw-r--r-- .* Oct 19 10:2\d a\ndrwxr-xr-x .* Oct 19 10:2\d b$/);
  assert.match(run('timedatectl').stdout, /Local time: Mon 2026-10-19 10:2\d/);
  assert.equal(LAB_DAY * MS_PER_DAY, Date.UTC(2026, 9, 19));
  assert.ok(labNow().getTime() >= LAB_DATE);
});
