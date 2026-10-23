// No single command may freeze the page. Every case here hung the tab before (round-3 scan, L3-1, L3-18,
// L3-19); each must now answer quickly, with a clear note when the simulator refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxSession, windowsSession } from './testUtils.ts';
import { regexShape } from './safeRegex.ts';
import { globToRegex } from './textUtils.ts';

const A34C = 'a'.repeat(34) + 'c';

/** Runs a line and returns its result, failing the test if it took more than `ms` */
function quick<T>(fn: () => T, ms = 2000): T {
  const start = Date.now();
  const res = fn();
  assert.ok(Date.now() - start < ms, `took ${Date.now() - start} ms`);
  return res;
}

test('nested repetition is refused with a note in grep, sed, awk and Select-String instead of hanging', () => {
  const run = linuxSession();
  for (const line of [
    'grep -E "(.*)*x" /var/log/auth.log',
    `echo ${A34C} | grep -E "(a*)*b"`,
    'grep "\\(a*\\)*b" /var/log/auth.log',
    `echo ${A34C} | sed -E "s/(a*)*b/x/"`,
    `echo ${A34C} | awk "/(a*)*b/"`,
    `echo ${A34C} | awk '$0 ~ "(a+)+b"'`,
  ]) {
    const res = quick(() => run(line));
    assert.equal(res.exitCode, 1, line);
    assert.match(res.stderr, /^(grep|sed|awk): simulator limit: this pattern repeats a group/, line);
  }
  const ps = windowsSession('powershell');
  const res = quick(() => ps(`"${A34C}" | Select-String "(a+)+b"`));
  assert.match(res.stderr, /^Select-String: simulator limit/);
});

test('many .* on a very long line are refused; ordinary patterns on ordinary input still work', () => {
  const run = linuxSession();
  const long = quick(() => run('printf "%9000s\\n" x | grep ".*a.*b.*c"'));
  assert.match(long.stderr, /^grep: simulator limit: this pattern has 3 parts like \.\*/);

  assert.match(run('grep -E "([0-9]+\\.){3}[0-9]+" /var/log/auth.log').stdout, /198\.51\.100\.44/);
  assert.match(run('grep "Failed.*from" /var/log/auth.log').stdout, /Failed password/);
  assert.equal(run('echo abc.example.com | grep -cE "([a-z]+\\.)+com"').stdout, '1');
  assert.equal(run('echo "a b c" | sed -E "s/(a|b)+/X/"').stdout, 'X b c');
});

test('the pattern-shape check tells risky repetition from safe repetition', () => {
  for (const risky of ['(.*)*x', '(a*)*b', '(a+)+b', '(\\w+\\s?)+$', '(a|b*)+', '((a)*)*']) {
    assert.equal(regexShape(risky).nested, true, risky);
  }
  for (const safe of ['(?:\\d+\\.){3}\\d+', '([a-z]+\\.)+com', '(foo|bar)+', '(ab)*', '(x(y+))+', 'a{2,5}', '[(]*']) {
    assert.equal(regexShape(safe).nested, false, safe);
  }
});

test('wildcards match in linear time: *a*a*...*b against a long name answers at once', () => {
  const run = linuxSession();
  run(`touch ${'a'.repeat(40)}`);
  const res = quick(() => run(`echo ${'*a'.repeat(14)}*b`));
  assert.equal(res.stdout, `${'*a'.repeat(14)}*b`, 'no match, so bash prints the pattern itself');
  assert.equal(quick(() => run('x=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac; echo ${x#*a*a*a*a*a*a*a*a*a*a*a*a*b}')).exitCode, 0);
  assert.equal(globToRegex('*.t?t').test('notes.txt'), true);
  assert.equal(globToRegex('a*b*c').test('axxbyyc'), true);
  assert.equal(globToRegex('a*b*c').test('axxbyy'), false);
  assert.equal(globToRegex('[!a]*').test('abc'), false);
});

test('a script that starts itself stops at the line budget, and a runaway variable is refused, machine unchanged', () => {
  const run = linuxSession();
  run('printf "./f.sh\\n./f.sh\\n./f.sh\\n./f.sh\\n./f.sh\\n./f.sh\\n" > f.sh');
  run('chmod +x f.sh');
  const fan = quick(() => run('./f.sh'), 5000);
  assert.equal(fan.exitCode, 1);
  assert.match(fan.stderr, /^bash: simulator limit: this command ran more than 5000 command lines/);

  run('x=ab');
  const grow = quick(() => run(Array(22).fill('x=$x$x').join('; ')));
  assert.match(grow.stderr, /^bash: simulator limit: the value of x is longer/);
  assert.equal(run('echo $x').stdout, 'ab', 'the refused line changed nothing');
  assert.equal(run('echo ok').stdout, 'ok', 'the next command runs normally');
});

test('brace expansion says so when it would make too many words, instead of silently stopping', () => {
  const run = linuxSession();
  assert.match(run('echo {1..100000} | wc -c').stderr, /brace expansion makes more than 10000 words/);
  assert.equal(run('echo {1..5}').stdout, '1 2 3 4 5');
});
