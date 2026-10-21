import test from 'node:test';
import assert from 'node:assert/strict';
import { getNodeAtPath } from './filesystem.ts';
import { linuxSession } from './testUtils.ts';
import { NOT_SIMULATED_LINUX } from './notSimulated.ts';
import { linuxCommands } from './linux/context.ts';

// Bash word expansion, special parameters, input redirection and substitutions (fact-check E-1, E-2, E-3/L-5, E-16)

test('quoting: single quotes and \\$ are literal, double quotes expand, adjacent pieces join', () => {
  const run = linuxSession();
  assert.equal(run("echo '$HOME'").stdout, '$HOME');
  assert.equal(run('echo \\$HOME').stdout, '$HOME');
  assert.equal(run('echo "\\$HOME"').stdout, '$HOME');
  assert.equal(run('echo "$HOME"x').stdout, '/home/studentx');
  assert.equal(run('echo pre"$HOME"post').stdout, 'pre/home/studentpost');
  assert.equal(run("echo 'a'\"b\"c").stdout, 'abc');
  assert.equal(run('echo ~').stdout, '/home/student');
  assert.equal(run('echo ~/notes.txt ~root "~"').stdout, '/home/student/notes.txt /root ~');
  assert.equal(run('echo ${HOME}/x ${#USER} ${NOPE:-fallback}').stdout, '/home/student/x 7 fallback');
});

test('expansion happens for every command, not only echo', () => {
  const run = linuxSession();
  run('cd $HOME/scripts');
  assert.equal(run('pwd').stdout, '/home/student/scripts');
  run('cd ~');
  assert.equal(run('F=/etc/hostname; cat "$F"').stdout, 'lpi-lab01');
  assert.match(run('grep $USER /etc/passwd').stdout, /^student:x:1000/);
  run('D=/tmp');
  assert.match(run('ls -ld $D').stdout, /^drwxrwxrwt .* \/tmp$/);
  // Unquoted results are split into words; quoted ones are not
  run('V="a  b"');
  assert.equal(run('echo $V').stdout, 'a b');
  assert.equal(run('echo "$V"').stdout, 'a  b');
  // An empty unquoted expansion disappears; "" stays as an empty argument
  assert.equal(run('ls $NOTHING notes.txt').stdout, 'notes.txt');
  // NAME=value before a command applies to that command only
  run('GREETING=hi env > /tmp/env.txt');
  assert.match(getNodeAtPath(run.fs(), '/tmp/env.txt', false)?.content ?? '', /GREETING=hi/);
  assert.equal(run('echo "[$GREETING]"').stdout, '[]');
});

test('special parameters $? $$ $0 $RANDOM and USER', () => {
  const run = linuxSession();
  assert.equal(run('false; echo $?').stdout, '1');
  assert.equal(run('true; echo $?').stdout, '0');
  assert.equal(run('ls nosuch; echo $?').stdout, '2');
  run('nosuchcommand');
  assert.equal(run('echo $?').stdout, '127');
  assert.match(run('echo $$').stdout, /^\d+$/);
  assert.equal(run('echo $0').stdout, 'bash');
  const r = Number(run('echo $RANDOM').stdout);
  assert.ok(r >= 0 && r < 32768);
  assert.equal(run('echo $USER $LOGNAME').stdout, 'student student');
});

test('< and <<< redirect standard input', () => {
  const run = linuxSession();
  assert.match(run('tr a-z A-Z < notes.txt').stdout, /^LPIC-1 STUDY NOTES:/);
  assert.equal(run('wc -l < notes.txt').stdout, '4');
  run('sort < notes.txt > sorted.txt');
  assert.match(getNodeAtPath(run.fs(), '/home/student/sorted.txt', false)?.content ?? '', /^- Remember/);
  const missing = run('cat < missing');
  assert.equal(missing.stderr, 'bash: missing: No such file or directory');
  assert.equal(missing.exitCode, 1);
  const denied = run('cat < /etc/shadow');
  assert.equal(denied.stderr, 'bash: /etc/shadow: Permission denied');
  assert.equal(denied.exitCode, 1);
  assert.equal(run('tr a-z A-Z <<< "here string"').stdout, 'HERE STRING');
});

test('command substitution, backticks and arithmetic', () => {
  const run = linuxSession();
  assert.equal(run('echo $(whoami)').stdout, 'student');
  assert.equal(run('echo `whoami`').stdout, 'student');
  assert.equal(run('echo "user: $(id -un) on $(hostname)"').stdout, 'user: student on lpi-lab01');
  assert.equal(run('echo $(echo a; echo b)').stdout, 'a b');
  assert.equal(run('echo "$(echo a; echo b)"').stdout, 'a\nb');
  assert.equal(run('echo $((2+3)) $((7/2)) $((2**10)) $(( (1+2)*3 ))').stdout, '5 3 1024 9');
  run('N=4');
  assert.equal(run('echo $((N*2)) $(($N+1))').stdout, '8 5');
  const div = run('echo $((1/0))');
  assert.equal(div.stderr, 'bash: 1/0: division by 0 (error token is "0")');
  assert.equal(div.exitCode, 1);
});

test('awk programs in single quotes keep their $ fields', () => {
  const run = linuxSession();
  assert.equal(run('echo "a b c d e" | awk \'{print $(NF-3)}\'').stdout, 'b');
  assert.equal(run('grep "Failed password" /var/log/auth.log | awk \'{print $(NF-3)}\' | sort | uniq -c').stdout.trim(), '3 198.51.100.44');
  assert.equal(run('echo "x y" | awk "{print \\$2}"').stdout, 'y');
});

test('printf: %s %d, escapes, width and format reuse', () => {
  const run = linuxSession();
  assert.equal(run('printf "%s-%d\\n" a 5 b 6').stdout, 'a-5\nb-6');
  assert.equal(run('printf "%5s|%-5s|%03d\\n" x y 7').stdout, '    x|y    |007');
  assert.equal(run('printf "%x %o %c %%\\n" 255 8 hello').stdout, 'ff 10 h %');
  assert.equal(run("printf 'a\\tb\\n'").stdout, 'a\tb');
  const bad = run('printf "%d\\n" abc');
  assert.equal(bad.stdout, '0');
  assert.equal(bad.stderr, 'bash: printf: abc: invalid number');
  assert.equal(bad.exitCode, 1);
});

test('printf: negative * precision counts as omitted and large precision never throws', () => {
  const run = linuxSession();
  assert.equal(run("printf '%.*f' -1 1").stdout, '1.000000');
  assert.equal(run("printf '%.*s|' -1 abc").stdout, 'abc|');
  const big = run("printf '%.101f' 1");
  assert.equal(big.exitCode, 0);
  assert.match(big.stdout, /^1\.0+$/);
  assert.equal(run("printf '%.150e' 1").exitCode, 0);
  assert.equal(run("printf '%.150g' 1").stdout, '1');
});

test('comments, |& and >&2', () => {
  const run = linuxSession();
  assert.equal(run('echo a # not printed').stdout, 'a');
  assert.equal(run('# only a comment').stdout, '');
  const both = run('ls nosuch |& cat');
  assert.equal(both.stdout, "ls: cannot access 'nosuch': No such file or directory");
  assert.equal(both.stderr, '');
  const toErr = run('echo oops >&2');
  assert.equal(toErr.stdout, '');
  assert.equal(toErr.stderr, 'oops');
  run('echo out > /tmp/both.txt 2>&1; ls nosuch &> /tmp/both.txt');
  assert.match(getNodeAtPath(run.fs(), '/tmp/both.txt', false)?.content ?? '', /^ls: cannot access/);
});

test('setgid directories pass their group on, and numeric chmod keeps setgid', () => {
  const run = linuxSession();
  run('mkdir proj; sudo chgrp finance proj; sudo chmod 2770 proj');
  run('touch proj/f; mkdir proj/d; echo x > proj/r');
  const node = (p: string) => getNodeAtPath(run.fs(), `/home/student/${p}`, false)!;
  assert.equal(node('proj/f').group, 'finance');
  assert.equal(node('proj/r').group, 'finance');
  assert.equal(node('proj/d').group, 'finance');
  assert.match(run('ls -ld proj/d').stdout, /^drwxr-sr-x /);
  run('chmod 755 proj');
  assert.match(run('ls -ld proj').stdout, /^drwxr-sr-x /);
  run('chmod 00755 proj');
  assert.match(run('ls -ld proj').stdout, /^drwxr-xr-x /);
  run('chmod g+s proj; chmod 0755 proj');
  assert.match(run('ls -ld proj').stdout, /^drwxr-sr-x /, '0755 still keeps it on a directory');
  // On a regular file a numeric mode does clear the bits
  run('touch g; chmod 2755 g; chmod 755 g');
  assert.match(run('ls -l g').stdout, /^-rwxr-xr-x /);
});

test('cp -p and -a into a setgid directory keep the source group', () => {
  const run = linuxSession();
  run('mkdir proj; sudo chgrp finance proj; sudo chmod 2770 proj');
  run('touch mine; mkdir tree; touch tree/leaf');
  const node = (p: string) => getNodeAtPath(run.fs(), `/home/student/${p}`, false)!;
  run('cp mine proj/plain');
  assert.equal(node('proj/plain').group, 'finance');
  run('cp -p mine proj/kept');
  assert.equal(node('proj/kept').group, 'student');
  run('cp -a tree proj/tree');
  assert.equal(node('proj/tree').group, 'student');
  assert.equal(node('proj/tree/leaf').group, 'student');
  // root keeps owner and group whatever they are
  run('sudo touch rootfile; sudo cp -p rootfile proj/rootcopy');
  assert.equal(node('proj/rootcopy').owner, 'root');
  assert.equal(node('proj/rootcopy').group, 'root');
});

test('id -u, -g, -G and -n print one part', () => {
  const run = linuxSession();
  assert.equal(run('id -u').stdout, '1000');
  assert.equal(run('id -un').stdout, 'student');
  assert.equal(run('id -gn').stdout, 'student');
  assert.equal(run('id -g').stdout, '1000');
  assert.equal(run('id -Gn').stdout, 'student adm sudo');
  assert.equal(run('sudo id -u').stdout, '0');
  assert.equal(run('id -u root').stdout, '0');
});

test('real commands that are not simulated say so', () => {
  const run = linuxSession();
  const res = run('fsck /dev/sda1');
  assert.equal(res.stderr, 'bash: fsck: this command exists on real systems but is not simulated here');
  assert.equal(res.exitCode, 127);
  assert.equal(run('sudo modprobe e1000e').stderr, 'bash: modprobe: this command exists on real systems but is not simulated here');
  assert.equal(run('frobnicate').stderr, 'bash: frobnicate: command not found');
  // make is real: not "did you mean mawk"
  const make = run('sudo make me a sandwich');
  assert.equal(make.stderr, 'bash: make: this command exists on real systems but is not simulated here');
  assert.ok(!make.explanation?.includes('mawk'), make.explanation);
  // The list only names commands the simulator does not run
  assert.deepEqual(NOT_SIMULATED_LINUX.filter(n => linuxCommands.has(n)), []);
});

test('limits: a huge ping count or printf width never freezes the page', () => {
  const run = linuxSession();
  const t = Date.now();
  const ping = run('ping -c 100000000 8.8.8.8');
  assert.equal(ping.exitCode, 0);
  assert.equal(ping.stdout.split('\n').filter(l => l.includes('icmp_seq=')).length, 100);
  assert.match(ping.stdout, /shows the first 100 replies; a real ping -c 100000000/);
  assert.match(ping.stdout, /100000000 packets transmitted, 100000000 received/);
  assert.doesNotMatch(run('ping -c 4 8.8.8.8').stdout, /first 100 replies/);
  for (const line of ["printf '%999999999s' x", "printf '%*s' 999999999 x", "printf '%.999999999d' 1"]) {
    const r = run(line);
    assert.equal(r.exitCode, 1, line);
    assert.match(r.stderr, /larger than this simulator allows \(10000\)/, line);
  }
  assert.equal(run("printf '%5s|' ab").stdout, '   ab|');
  const awk = run(`awk 'BEGIN{printf "%999999999s", 1}'`);
  assert.equal(awk.exitCode, 2);
  assert.match(awk.stderr, /^awk: format width or precision is larger than this simulator allows/);
  assert.equal(run(`awk 'BEGIN{printf "%.150f", 1}'`).exitCode, 0, 'large precision is clamped, not thrown');
  assert.ok(Date.now() - t < 2000, 'all of the above returns quickly');
});
