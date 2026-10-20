import test from 'node:test';
import assert from 'node:assert/strict';
import { getNodeAtPath } from './filesystem.ts';
import { parseOptions, posixToJsRegex } from './textUtils.ts';
import { tokenizeArgs, parsePipelinedLine } from './parser.ts';
import { linuxSession } from './testUtils.ts';

const PASSWD_USERS = 'root\ndaemon\nbin\nsys\nstudent\nnginx';

test('parseOptions splits combined flags, takes values and permutes operands', () => {
  const o = parseOptions(['-rin', 'pat', '-d:', 'file', '-f', '2', '--count', '--', '-x'], 'df', { count: 'c' });
  assert.deepEqual([...o.flags].sort(), ['c', 'i', 'n', 'r']);
  assert.deepEqual(o.values.get('d'), [':']);
  assert.deepEqual(o.values.get('f'), ['2']);
  assert.deepEqual(o.operands, ['pat', 'file', '-x']);
});

test('posixToJsRegex translates BRE and ERE', () => {
  assert.equal(posixToJsRegex('a\\(b\\)\\{2\\}', false), 'a(b){2}');
  assert.equal(posixToJsRegex('a(b)|c+', false), 'a\\(b\\)\\|c\\+');
  assert.equal(posixToJsRegex('a(b)|c+', true), 'a(b)|c+');
  assert.equal(posixToJsRegex('[[:digit:]]+', true), '[0-9]+');
});

test('Filters read named files, not just stdin', () => {
  const run = linuxSession();
  const sorted = run('sort /etc/passwd');
  assert.equal(sorted.exitCode, 0);
  assert.equal(sorted.stdout.split('\n')[0], 'bin:x:2:2:bin:/bin:/usr/sbin/nologin');
  assert.equal(run('uniq /etc/passwd').stdout.split('\n').length, 6);
  assert.match(run('sed s/root/x/ /etc/passwd').stdout, /^x:x:0:0:root:\/root/);
  assert.equal(run('awk -F: \'{print $1}\' /etc/passwd').stdout, PASSWD_USERS);
  assert.equal(run('cut -d: -f1 /etc/passwd').stdout, PASSWD_USERS);
  assert.equal(run('head -n 1 /etc/passwd').stdout, 'root:x:0:0:root:/root:/bin/bash');
  assert.equal(run('tail -n 1 /etc/passwd').stdout, 'nginx:x:1001:1001:Nginx Web Server,,,:/var/www:/usr/sbin/nologin');
  assert.equal(run('wc -l /etc/passwd').stdout, '6 /etc/passwd');
});

test('Missing and unreadable files give the real message and exit code', () => {
  const run = linuxSession();
  const cases: [string, string, number][] = [
    ['sort nofile', 'sort: cannot read: nofile: No such file or directory', 2],
    ['sort /etc/shadow', 'sort: open failed: /etc/shadow: Permission denied', 2],
    ['uniq nofile', 'uniq: nofile: No such file or directory', 1],
    ['sed p nofile', "sed: can't read nofile: No such file or directory", 2],
    ['head nofile', "head: cannot open 'nofile' for reading: No such file or directory", 1],
    ['tail /etc/shadow', "tail: cannot open '/etc/shadow' for reading: Permission denied", 1],
    ['wc nofile', 'wc: nofile: No such file or directory', 1],
    ['grep x nofile', 'grep: nofile: No such file or directory', 2],
    ['awk 1 nofile', 'awk: cannot open nofile (No such file or directory)', 2],
    ['cut -f1 nofile', 'cut: nofile: No such file or directory', 1],
    ['cat /etc', 'cat: /etc: Is a directory', 1],
    ['grep x /etc', 'grep: /etc: Is a directory', 2],
  ];
  for (const [line, stderr, code] of cases) {
    const res = run(line);
    assert.equal(res.stderr, stderr, line);
    assert.equal(res.exitCode, code, line);
  }
  assert.ok(run('sort /etc/shadow').explanation, 'denials through the input helper carry an explanation');
  // Other files are still processed
  const mixed = run('cat nofile /etc/hostname /etc/resolv.conf');
  assert.match(mixed.stdout, /nameserver/);
  assert.equal(mixed.exitCode, 1);
});

test('grep: -i -v -n -c -l -E -F -w -o -q and combined flags', () => {
  const run = linuxSession();
  assert.equal(run('grep -n root /etc/passwd').stdout, '1:root:x:0:0:root:/root:/bin/bash');
  assert.equal(run('grep -c nologin /etc/passwd').stdout, '4');
  assert.equal(run('grep -vc nologin /etc/passwd').stdout, '2');
  assert.equal(run('grep -i ROOT /etc/passwd').exitCode, 0);
  assert.equal(run('grep -E "^(root|nginx):" /etc/passwd').stdout.split('\n').length, 2);
  assert.equal(run('grep "^\\(root\\|nginx\\):" /etc/passwd').stdout.split('\n').length, 2, 'BRE alternation');
  assert.equal(run('grep -F "a.b" /etc/passwd').exitCode, 1);
  assert.equal(run('grep -l root /etc/passwd /etc/group').stdout, '/etc/passwd\n/etc/group');
  assert.equal(run('grep -c root /etc/passwd /etc/group').stdout, '/etc/passwd:1\n/etc/group:1');
  assert.equal(run('grep -o "x:[0-9]*" /etc/hostname 2>/dev/null').exitCode, 2);
  assert.equal(run('grep -ow bin /etc/passwd').stdout, 'bin\nbin\nbin\nbin\nbin');
  assert.equal(run('grep -q root /etc/passwd').stdout, '');
  assert.equal(run('grep -q root /etc/passwd').exitCode, 0);
  assert.equal(run('grep -e root -e sys /etc/passwd').stdout.split('\n').length, 2);
  assert.equal(run('echo hello | grep -n l').stdout, '1:hello');
});

test('grep -r / -R recurse with path:line output and report unreadable files', () => {
  const run = linuxSession();
  const res = run('grep -rin "failed password" /var/log');
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /^\/var\/log\/auth\.log:2:Oct 19 09:12:33/);
  assert.equal(res.stdout.split('\n').length, 3);

  const etc = run('grep -r student /etc');
  assert.match(etc.stdout, /\/etc\/group:sudo:x:27:student/);
  assert.match(etc.stdout, /\/etc\/passwd:student:x:1000/);
  assert.equal(etc.stderr, 'grep: /etc/shadow: Permission denied');
  assert.equal(etc.exitCode, 2);

  run('cd /home/student');
  const rel = run('grep -R Tar');
  assert.equal(rel.stdout, 'notes.txt:- Tar syntax: c=create, x=extract, v=verbose, z=gzip, f=file');
  assert.equal(run('grep -rl backup .').stdout, './scripts/backup.sh');
});

test('awk: patterns, $NF, NR, -v, arrays and END', () => {
  const run = linuxSession();
  assert.equal(run('awk -F: \'$3 >= 1000 {print $1}\' /etc/passwd').stdout, 'student\nnginx');
  assert.equal(run('awk -F: \'NR==1 {print $NF}\' /etc/passwd').stdout, '/bin/bash');
  assert.equal(run('awk -F: -v OFS=- \'/root/ {print $1, $7}\' /etc/passwd').stdout, 'root-/bin/bash');
  assert.equal(run('awk -F: \'{n[$7]++} END {print n["/bin/bash"]}\' /etc/passwd').stdout, '2');
  assert.equal(run('awk \'END {print NR}\' /etc/passwd').stdout, '6');
  assert.equal(run('echo "a b c" | awk \'{print $(NF-1)}\'').stdout, 'b');
  assert.equal(run('awk \'{print $1\' /etc/passwd').exitCode, 2);
});

test('sed: per-line substitution, addresses, -n p, d, -E, -i', () => {
  const run = linuxSession();
  assert.equal(run('echo "aaa" | sed s/a/b/').stdout, 'baa');
  assert.equal(run('echo "aaa" | sed s/a/b/g').stdout, 'bbb');
  assert.equal(run('printf x | sed s/x/y/ 2>/dev/null; echo -e "x\\nx" | sed s/^x/y/').stdout, 'y\ny');
  assert.equal(run('sed -n 2p /etc/passwd').stdout, 'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin');
  assert.equal(run('sed -n "/^s/p" /etc/passwd').stdout.split('\n').length, 2);
  assert.equal(run('sed "/nologin/d" /etc/passwd').stdout.split('\n').length, 2);
  assert.equal(run('sed 2,5d /etc/passwd').stdout.split('\n').length, 2);
  assert.equal(run('echo "ab" | sed -E "s/(a)(b)/\\2\\1/"').stdout, 'ba');
  assert.equal(run('echo "ab" | sed "s/\\(a\\)/[&]/"').stdout, '[a]b');
  assert.equal(run('echo "a/b" | sed "s|/|:|"').stdout, 'a:b');
  assert.match(run('sed zz /etc/passwd').stderr, /unknown command/);

  run('sed -i "s/Tar/TAR/" notes.txt');
  assert.match(getNodeAtPath(run.fs(), '/home/student/notes.txt', false)?.content ?? '', /TAR syntax/);
  const denied = run('sed -i s/root/x/ /etc/passwd');
  assert.match(denied.stderr, /couldn't open temporary file \/etc\/sedXXXXXX: Permission denied/);
  assert.equal(denied.exitCode, 4);
  assert.ok(denied.explanation);
});

test('sort: -n -r -u -k -t -f -o', () => {
  const run = linuxSession();
  assert.equal(run('cut -d: -f3 /etc/passwd | sort -n').stdout, '0\n1\n2\n3\n1000\n1001');
  assert.equal(run('cut -d: -f3 /etc/passwd | sort -nr | head -1').stdout, '1001');
  assert.equal(run('sort -t: -k3 -n /etc/passwd | head -1').stdout.split(':')[0], 'root');
  assert.equal(run('sort -t: -k3,3nr /etc/passwd | head -1').stdout.split(':')[0], 'nginx');
  assert.equal(run('echo -e "b\\na\\nb" | sort -u').stdout, 'a\nb');
  run('sort -o sorted.txt /etc/passwd');
  assert.match(getNodeAtPath(run.fs(), '/home/student/sorted.txt', false)?.content ?? '', /^bin:/);
});

test('uniq only collapses adjacent lines, with -c -d -u', () => {
  const run = linuxSession();
  assert.equal(run('echo -e "a\\na\\nb\\na" | uniq').stdout, 'a\nb\na');
  assert.equal(run('echo -e "a\\na\\nb\\na" | uniq -c').stdout, '      2 a\n      1 b\n      1 a');
  assert.equal(run('echo -e "a\\na\\nb\\na" | sort | uniq -c').stdout, '      3 a\n      1 b');
  assert.equal(run('echo -e "a\\na\\nb" | uniq -d').stdout, 'a');
  assert.equal(run('echo -e "a\\na\\nb" | uniq -u').stdout, 'b');
});

test('wc counts like GNU wc', () => {
  const run = linuxSession();
  assert.equal(run('echo hi | wc -c').stdout, '3');
  assert.equal(run('echo hello world | wc -w').stdout, '2');
  assert.equal(run('echo hello world | wc').stdout, '      1       2      12');
  assert.equal(run('wc /etc/hosts').stdout, '  4   8 111 /etc/hosts');
  const two = run('wc -l /etc/passwd /etc/group');
  assert.equal(two.stdout, '  6 /etc/passwd\n  7 /etc/group\n 13 total');
});

test('head and tail: counts, +N, -c and multi-file headers', () => {
  const run = linuxSession();
  assert.equal(run('head -2 /etc/passwd | tail -1').stdout.split(':')[0], 'daemon');
  assert.equal(run('tail -n +5 /etc/passwd').stdout.split('\n').length, 2);
  assert.equal(run('head -c 4 /etc/passwd').stdout, 'root');
  assert.equal(run('head -n 1 /etc/passwd /etc/group').stdout,
    '==> /etc/passwd <==\nroot:x:0:0:root:/root:/bin/bash\n\n==> /etc/group <==\nroot:x:0:');
  assert.match(run('head -n x /etc/passwd').stderr, /invalid number of lines/);
});

test('cut: fields, characters, ranges and errors', () => {
  const run = linuxSession();
  assert.equal(run('cut -d: -f1,3 /etc/passwd | head -1').stdout, 'root:0');
  assert.equal(run('cut -d: -f6- /etc/passwd | head -1').stdout, '/root:/bin/bash');
  assert.equal(run('cut -c1-4 /etc/passwd | head -1').stdout, 'root');
  assert.equal(run('echo "a b c" | cut -d " " -f2').stdout, 'b');
  assert.equal(run('echo nodelim | cut -d: -f2').stdout, 'nodelim');
  assert.equal(run('echo nodelim | cut -s -d: -f2').stdout, '');
  assert.match(run('cut /etc/passwd').stderr, /you must specify a list of bytes, characters, or fields/);
  assert.match(run('cut -d:: -f1 /etc/passwd').stderr, /the delimiter must be a single character/);
  assert.match(run('cut -f0 /etc/passwd').stderr, /numbered from 1/);
});

test('tr: ranges, classes, -d, -s, and no file operands', () => {
  const run = linuxSession();
  assert.equal(run('echo hello | tr a-z A-Z').stdout, 'HELLO');
  assert.equal(run('echo hello | tr "[:lower:]" "[:upper:]"').stdout, 'HELLO');
  assert.equal(run('echo hello | tr -d l').stdout, 'heo');
  assert.equal(run('echo "a   b" | tr -s " "').stdout, 'a b');
  assert.equal(run('echo abc | tr abc x').stdout, 'xxx');
  assert.equal(run('echo "ph: 555-1234" | tr -cd "[:digit:]"').stdout, '5551234');
  assert.equal(run('cat /etc/hostname 2>/dev/null; echo a:b | tr : "\\n"').stdout, 'a\nb');
  const extra = run('tr a b /etc/passwd');
  assert.equal(extra.stderr, "tr: extra operand '/etc/passwd'\nTry 'tr --help' for more information.");
  assert.equal(extra.exitCode, 1);
  assert.match(run('echo x | tr a').stderr, /Two strings must be given when translating/);
});

test('echo expands variables from the session and supports -e', () => {
  const run = linuxSession();
  assert.equal(run('echo $USER $HOME $SHELL').stdout, 'student /home/student /bin/bash');
  assert.equal(run('echo ${USER}x $NOPE.').stdout, 'studentx .');
  assert.equal(run('echo -e "a\\tb"').stdout, 'a\tb');
  assert.equal(run('cat -n /etc/hosts | head -1').stdout, '     1\t127.0.0.1 localhost');
});

test('Parser: quoting follows each shell', () => {
  assert.deepEqual(tokenizeArgs('echo "a\\tb" \'c\\d\' e\\ f "q\\"x"'), ['echo', 'a\\tb', 'c\\d', 'e f', 'q"x']);
  assert.deepEqual(tokenizeArgs('echo ""'), ['echo', '']);
  assert.deepEqual(tokenizeArgs('type C:\\Users\\Student\\a.txt', 'cmd'), ['type', 'C:\\Users\\Student\\a.txt']);
  assert.deepEqual(tokenizeArgs('echo it\'s "a b" x^&y', 'cmd'), ['echo', "it's", 'a b', 'x&y']);
  assert.deepEqual(tokenizeArgs("Get-Content 'C:\\a b.txt'", 'powershell'), ['Get-Content', 'C:\\a b.txt']);
  const p = parsePipelinedLine('type "a|b.txt" | findstr x > C:\\out.txt', 'cmd');
  assert.equal(p.length, 2);
  assert.deepEqual(p[0].args, ['a|b.txt']);
  assert.deepEqual(p[1].redirect, { type: '>', target: 'C:\\out.txt' });
});
