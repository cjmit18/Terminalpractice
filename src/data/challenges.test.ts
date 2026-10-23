import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandContext, ExamModule } from '../types/modules.ts';
import { TerminalShell } from '../types/terminal.ts';
import { executeLinuxLine } from '../terminal/linuxEngine.ts';
import { executeWindowsLine } from '../terminal/windowsEngine.ts';
import { LPI_MODULES } from './lpiModules.ts';
import { WINDOWS_PBQS } from './windowsPbqs.ts';
import { CHALLENGES, Challenge, challengeFact, dailyOrder, nextChallenge, todaysPick } from './challenges.ts';
import { parseHash, routeHref } from '../lib/router.ts';

const MODULES = new Map<string, ExamModule>([...LPI_MODULES, ...WINDOWS_PBQS].map(m => [m.id, m]));

/** A fresh copy of the challenge's machine; returns whether each command passes the challenge. */
function machine(c: Challenge) {
  const m = MODULES.get(c.machineFrom);
  if (!m) throw new Error(`${c.id}: no lab ${c.machineFrom}`);
  let fs = structuredClone(m.initialFs);
  let state = structuredClone(m.initialState);
  let cwd = m.track === 'lpi' ? '/home/student' : 'C:\\Users\\Student';
  const shell: TerminalShell = c.shell;
  return (line: string): { passed: boolean; ctx: CommandContext } => {
    const res = shell === 'bash' ? executeLinuxLine(line, cwd, fs, state) : executeWindowsLine(line, cwd, fs, state, shell, false);
    ({ newFs: fs, newState: state, newCwd: cwd } = res);
    const ctx: CommandContext = { command: line, exitCode: res.exitCode, stdout: res.stdout };
    return { passed: c.verifier(fs, state, ctx), ctx };
  };
}

// Plausible near misses: the whole file, an echoed guess, the wrong count or filter
const WRONG: Record<string, string[]> = {
  'bash-login-shells': ['cat /etc/passwd', 'echo 2', 'grep -c nologin /etc/passwd', 'wc -l /etc/passwd', 'cat /etc/passwd >/dev/null; echo 2', 'grep -c bash /etc/passwd && echo 2',
    // Quoting or a path does not hide the command name from the check (the shell still runs echo / printf)
    'cat /etc/passwd >/dev/null; e"ch"o 2', "cat /etc/passwd >/dev/null; 'echo' 2", 'cat /etc/passwd >/dev/null; \\echo 2',
    "cat /etc/passwd >/dev/null; pr'in'tf 2", 'cat /etc/passwd >/dev/null; "/bin/echo" 2'],
  'bash-sshd-line': ['cat /var/log/syslog', 'grep sshd /var/log/auth.log', 'grep nginx /var/log/syslog', 'echo "sshd[2410]: listening /var/log/syslog"', "grep -o 'sshd\\[2410\\]' /var/log/syslog"],
  'bash-failed-count': ['wc -l /var/log/auth.log', 'grep -c sshd /var/log/syslog', 'echo 3', 'grep "Failed password" /var/log/auth.log'],
  'bash-suid-programs': ['ls -l /usr/bin', 'ls /usr/bin', 'find /usr/bin -perm -2000'],
  'bash-listening-ports': ['ps aux', 'ss -tan', 'cat /etc/hosts'],
  'bash-name-servers': ['cat /etc/resolv.conf', 'grep search /etc/resolv.conf', 'grep nameserver /etc/hosts', "grep nameserver /etc/resolv.conf | sed 's/[0-9]/1/g'"],
  'bash-adm-group': ['cat /etc/group', 'grep student /etc/group', 'getent group sudo'],
  'bash-boot-usage': ['df -h', 'df /boot', 'du -sh /boot'],
  'cmd-port-4444-pid': ['netstat -ano', 'netstat -ano | findstr 445', 'echo 3892'],
  'cmd-port-4444-program': ['tasklist', 'tasklist /fi "PID eq 844"', 'netstat -ano | findstr 4444'],
  'cmd-ipv4-address': ['ipconfig', 'ipconfig | findstr Subnet', 'hostname'],
  'cmd-hosts-dc01': ['type C:\\Windows\\System32\\drivers\\etc\\hosts', 'findstr localhost C:\\Windows\\System32\\drivers\\etc\\hosts', 'echo 192.168.1.10 dc01'],
  'ps-stopped-services': ['Get-Service', 'Get-Service W32Time', 'Get-Service | Where-Object Status -eq Running'],
  'ps-top-cpu': ['Get-Process', 'Get-Process | Sort-Object CPU | Select-Object -First 1', 'Get-Process -Id 2140'],
  'ps-servicing-stack': ['Get-Content C:\\Logs\\CBS.log', 'Select-String -Path C:\\Logs\\CBS.log -Pattern CBS', 'Write-Output "Servicing Stack v10.0.22621.1 CBS.log"'],
};

test('there are at least 10 challenges (no upper cap) across bash, Command Prompt and PowerShell, with unique ids', () => {
  assert.ok(CHALLENGES.length >= 10, `${CHALLENGES.length} challenges`);
  assert.equal(new Set(CHALLENGES.map(c => c.id)).size, CHALLENGES.length);
  for (const shell of ['bash', 'cmd', 'powershell'] as const) {
    assert.ok(CHALLENGES.some(c => c.shell === shell), `no ${shell} challenge`);
  }
});

test('every challenge runs on an existing lab machine and has a prompt, hint and explanation in the plain voice', () => {
  for (const c of CHALLENGES) {
    const m = MODULES.get(c.machineFrom);
    assert.ok(m, `${c.id}: unknown lab ${c.machineFrom}`);
    // A Linux challenge on a Linux machine, a Windows one on a Windows machine
    assert.equal(c.shell === 'bash', m.track === 'lpi', `${c.id}: shell does not match the machine`);
    for (const text of [c.title, c.prompt, c.hint, c.explanation]) {
      assert.ok(text.trim().length > 0, `${c.id}: empty text`);
      assert.ok(!text.includes('!'), `${c.id}: no exclamation marks: ${text}`);
    }
    assert.ok(challengeFact(c.id).startsWith('challenge:'));
    assert.match(challengeFact(c.id), /^[a-z0-9][A-Za-z0-9:/._-]{0,159}$/, 'a valid activity fact');
  }
});

test('replay: every challenge is solved by its solution on a fresh machine', () => {
  for (const c of CHALLENGES) {
    const run = machine(c);
    let last: ReturnType<typeof run> | undefined;
    for (const line of c.solution) last = run(line);
    assert.ok(last, `${c.id}: no solution`);
    assert.equal(last.ctx.exitCode, 0, `${c.id}: the solution failed:\n${last.ctx.stdout}`);
    assert.ok(last.passed, `${c.id}: the solution did not pass. Output:\n${last.ctx.stdout}`);
  }
});

// Other correct ways: the checks look at the answer, not one exact command
const ALSO_RIGHT: Record<string, string[]> = {
  'bash-login-shells': ['grep /bin/bash /etc/passwd | wc -l', "grep -c ':/bin/bash$' /etc/passwd"],
  // The commands the lessons teach: find exits 1 because /root cannot be read, with the right matches printed
  'bash-suid-programs': ['find / -perm -4000', 'find / -perm -4000 2>/dev/null', 'find / -perm -4000 -type f 2> /dev/null', 'find /usr/bin -perm -u=s'],
  'bash-sshd-line': ['grep -i sshd /var/log/syslog'],
  'bash-failed-count': ["grep 'Failed password' /var/log/auth.log | wc -l"],
  'bash-listening-ports': ['netstat -tln', 'ss -ltn'],
  'bash-name-servers': ['grep ^nameserver /etc/resolv.conf'],
  'bash-adm-group': ["grep '^adm:' /etc/group"],
  'cmd-port-4444-pid': ['netstat -ano | findstr :4444'],
  'cmd-port-4444-program': ['tasklist | findstr 3892', 'tasklist /FI "PID eq 3892"'],
  'cmd-ipv4-address': ['ipconfig /all | findstr IPv4'],
  'cmd-hosts-dc01': ['type C:\\Windows\\System32\\drivers\\etc\\hosts | findstr dc01'],
  'ps-stopped-services': ['Get-Service | Where-Object {$_.Status -eq "Stopped"}', 'gsv | ? Status -eq Stopped'],
  'ps-top-cpu': ['gps | sort cpu -desc | select -first 1'],
  'ps-servicing-stack': ['Select-String -Path C:\\Logs\\CBS.log -Pattern Servicing'],
};

test('other correct commands pass too', () => {
  for (const [id, list] of Object.entries(ALSO_RIGHT)) {
    const c = CHALLENGES.find(x => x.id === id);
    assert.ok(c, id);
    for (const line of list) {
      const { passed, ctx } = machine(c)(line);
      assert.ok(passed, `${id}: "${line}" should pass. Output:\n${ctx.stdout}`);
    }
  }
});

test('wrong answers do not pass, and nothing passes before a command runs', () => {
  for (const c of CHALLENGES) {
    const wrong = WRONG[c.id];
    assert.ok(wrong && wrong.length > 0, `${c.id}: add wrong answers to this test`);
    const m = MODULES.get(c.machineFrom)!;
    assert.equal(c.verifier(m.initialFs, m.initialState, undefined), false, `${c.id}: passes with no command`);
    for (const line of wrong) {
      const { passed, ctx } = machine(c)(line);
      assert.equal(passed, false, `${c.id}: "${line}" should not pass. Output:\n${ctx.stdout}`);
    }
  }
});

test('a failed command never passes, even when its output looks right', () => {
  for (const c of CHALLENGES) {
    const run = machine(c);
    let last: ReturnType<typeof run> | undefined;
    for (const line of c.solution) last = run(line);
    const m = MODULES.get(c.machineFrom)!;
    // find's exit code 1 (some folder unreadable) still counts for the SUID challenge; 2 is a real failure
    const failed = c.id === 'bash-suid-programs' ? 2 : 1;
    assert.equal(c.verifier(m.initialFs, m.initialState, { ...last!.ctx, exitCode: failed }), false, `${c.id}: passes with exit code ${failed}`);
  }
});

test("today's pick depends only on the date and reaches every challenge", () => {
  const day = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h);
  assert.equal(todaysPick(day(2026, 10, 21, 0)).id, todaysPick(day(2026, 10, 21, 23)).id, 'same all day');
  const seen = new Set<string>();
  // Any 2n days in a row hold a whole cycle, which leads with every challenge once
  for (let i = 0; i < 2 * CHALLENGES.length; i++) seen.add(todaysPick(day(2026, 1, 1 + i)).id);
  assert.equal(seen.size, CHALLENGES.length, 'consecutive days reach every challenge');
  assert.notEqual(todaysPick(day(2026, 10, 21)).id, todaysPick(day(2026, 10, 22)).id);
});

test("today's order holds every challenge, is reshuffled each cycle, and never repeats the pick on consecutive days", () => {
  const day = (offset: number) => new Date(2026, 0, 1 + offset, 12);
  const n = CHALLENGES.length;
  const ids = (list: Challenge[]) => list.map(c => c.id);
  for (let i = 0; i < 4 * n; i++) {
    const order = dailyOrder(day(i));
    assert.deepEqual([...ids(order)].sort(), [...ids(CHALLENGES)].sort(), 'every challenge is shown');
    assert.equal(order[0].id, todaysPick(day(i)).id);
    assert.notEqual(todaysPick(day(i)).id, todaysPick(day(i + 1)).id, `day ${i}: same pick two days running`);
  }
  // Any 2n days in a row hold a whole cycle, so they lead with every challenge; the shuffle differs between cycles
  for (const startDay of [0, 5, 3 * n + 2]) {
    assert.equal(new Set(Array.from({ length: 2 * n }, (_, i) => todaysPick(day(startDay + i)).id)).size, n);
  }
  const cycles = new Set(Array.from({ length: 6 }, (_, k) => ids(dailyOrder(day(k * n))).join()));
  assert.ok(cycles.size > 1, 'the rotation is not the same every cycle');
  // A larger pool works the same way: nothing is capped
  const big = Array.from({ length: 40 }, (_, i) => ({ ...CHALLENGES[i % n], id: `c${i}` }));
  assert.equal(new Set(Array.from({ length: 80 }, (_, i) => todaysPick(day(i), big).id)).size, 40);
});

test('router: challenge routes round-trip and leave the other sandbox route alone', () => {
  assert.deepEqual(parseHash('#/sandbox'), { section: 'sandbox' });
  assert.deepEqual(parseHash('#/sandbox/challenge'), { section: 'sandbox', challengeId: null });
  assert.deepEqual(parseHash('#/sandbox/challenge/bash-login-shells'), { section: 'sandbox', challengeId: 'bash-login-shells' });
  assert.equal(parseHash('#/sandbox/challenge/a/b'), null);
  assert.equal(parseHash('#/sandbox/other'), null);
  assert.equal(routeHref({ section: 'sandbox', challengeId: null }), '#/sandbox/challenge');
  assert.equal(routeHref({ section: 'sandbox', challengeId: 'a b' }), '#/sandbox/challenge/a%20b');
  assert.equal(routeHref({ section: 'sandbox' }), '#/sandbox');
  for (const c of CHALLENGES) {
    assert.deepEqual(parseHash(routeHref({ section: 'sandbox', challengeId: c.id })), { section: 'sandbox', challengeId: c.id });
  }
});

test('story notes: every lab has a short Northwind ticket in the calm voice', () => {
  const names = new Set<string>();
  for (const m of MODULES.values()) {
    const t = m.ticket;
    assert.ok(t, `${m.id}: no ticket`);
    names.add(t.from);
    for (const text of [t.from, t.role, t.ask, t.thanks]) {
      assert.ok(text.trim().length > 0, `${m.id}: empty ticket text`);
      assert.ok(!text.includes('!'), `${m.id}: no exclamation marks: ${text}`);
    }
    for (const text of [t.ask, t.thanks]) {
      const sentences = text.split(/[.?](?:\s|$)/).filter(s => s.trim()).length;
      assert.ok(sentences <= 2, `${m.id}: one or two sentences: ${text}`);
      // The admin is "you", never "he" or "she"
      assert.doesNotMatch(text, /\b(he|she|his|hers)\b/i, `${m.id}: ${text}`);
    }
  }
  assert.ok(names.size >= 10, 'a varied cast');
});

test('next challenge wraps around the list', () => {
  assert.equal(nextChallenge(CHALLENGES[0].id).id, CHALLENGES[1].id);
  assert.equal(nextChallenge(CHALLENGES[CHALLENGES.length - 1].id).id, CHALLENGES[0].id);
});
