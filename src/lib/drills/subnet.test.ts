import test from 'node:test';
import assert from 'node:assert/strict';
import { SUBNET_KINDS, checkSubnetAnswer, generateSubnetQuestion, parseDotted, toDotted, type SubnetQuestion } from './subnet.ts';
import { OBJECTIVES_BY_ID } from '../../data/examObjectives.ts';

// An independent calculation, on strings of bits instead of the 32-bit arithmetic the generator uses
const bits = (address: string) => address.split('.').map(o => Number(o).toString(2).padStart(8, '0')).join('');
const dotted = (b: string) => [0, 8, 16, 24].map(i => parseInt(b.slice(i, i + 8), 2)).join('.');
const subnet = (address: string, prefix: number) => {
  const head = bits(address).slice(0, prefix);
  const network = head.padEnd(32, '0');
  const broadcast = head.padEnd(32, '1');
  const plus = (b: string, n: number) => (BigInt(`0b${b}`) + BigInt(n)).toString(2).padStart(32, '0');
  return { network: dotted(network), broadcast: dotted(broadcast), first: dotted(plus(network, 1)), last: dotted(plus(broadcast, -1)) };
};
const isPrivate = (address: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);

/** What the independent calculation says the answer is, read from the question's own sentence */
function expected(q: SubnetQuestion): string {
  const cidr = /(\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(q.prompt);
  const prefix = Number(/\/(\d+)/.exec(q.prompt)?.[1]);
  switch (q.kind) {
    case 'network': return subnet(cidr![1], Number(cidr![2])).network;
    case 'broadcast': return subnet(cidr![1], Number(cidr![2])).broadcast;
    case 'first-host': return subnet(cidr![1], Number(cidr![2])).first;
    case 'last-host': return subnet(cidr![1], Number(cidr![2])).last;
    case 'host-count': return String(2 ** (32 - prefix) - 2);
    case 'mask': return dotted('1'.repeat(prefix).padEnd(32, '0'));
    case 'prefix': {
      const mask = /mask (\d+\.\d+\.\d+\.\d+)/.exec(q.prompt)![1];
      assert.match(bits(mask), /^1*0*$/, 'a real mask: ones, then zeros');
      return `/${bits(mask).indexOf('0')}`;
    }
    case 'same-subnet': {
      const [a, b] = [...q.prompt.matchAll(/\d+\.\d+\.\d+\.\d+/g)].map(m => m[0]);
      assert.notEqual(a, b);
      return bits(a).slice(0, prefix) === bits(b).slice(0, prefix) ? 'yes' : 'no';
    }
  }
}

test('subnet drills: for 4,000 seeds the answer matches an independent calculation', () => {
  const kinds = new Map<string, number>();
  const answers = new Set<string>();
  for (let seed = 0; seed < 4000; seed++) {
    const q = generateSubnetQuestion(seed * 7919 + 13);
    assert.equal(q.answer, expected(q), `seed ${q.seed}: ${q.prompt}`);
    assert.ok(checkSubnetAnswer(q, q.answer), `seed ${q.seed}: its own answer is accepted`);
    for (const m of q.prompt.matchAll(/\d+\.\d+\.\d+\.\d+/g)) {
      if (q.kind !== 'prefix') assert.ok(isPrivate(m[0]), `seed ${q.seed}: ${m[0]} is a private address`);
    }
    const prefix = Number(/\/(\d+)/.exec(q.prompt + q.answer)![1]);
    assert.ok(prefix >= 16 && prefix <= 30, `seed ${q.seed}: /${prefix}`);
    kinds.set(q.kind, (kinds.get(q.kind) ?? 0) + 1);
    answers.add(`${q.kind}:${q.answer}`);
  }
  for (const kind of SUBNET_KINDS) assert.ok((kinds.get(kind) ?? 0) > 300, `${kind} turns up often enough: ${kinds.get(kind)}`);
  assert.ok(answers.has('same-subnet:yes') && answers.has('same-subnet:no'), 'both answers turn up');
  assert.ok(answers.size > 1500, `many different answers, not a short list to memorise: ${answers.size}`);
});

test('subnet drills: a seed always gives the same question, and a kind can be asked for', () => {
  assert.deepEqual(generateSubnetQuestion(42), generateSubnetQuestion(42));
  assert.notDeepEqual(generateSubnetQuestion(42), generateSubnetQuestion(43));
  for (const kind of SUBNET_KINDS) {
    const q = generateSubnetQuestion(99, kind);
    assert.equal(q.kind, kind);
    assert.equal(q.answer, expected(q), q.prompt);
    assert.ok(q.explanation.length > 20);
    for (const id of q.objectives) assert.ok(OBJECTIVES_BY_ID.has(id), id);
  }
});

test('subnet drills: a host question never asks about the network or broadcast address itself', () => {
  for (let seed = 1; seed < 800; seed++) {
    const q = generateSubnetQuestion(seed, 'network');
    const [, address, prefix] = /(\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(q.prompt)!;
    const s = subnet(address, Number(prefix));
    assert.ok(address !== s.network && address !== s.broadcast, q.prompt);
  }
});

test('subnet drills: the checker accepts other ways to write the answer, and refuses near misses', () => {
  const q = (kind: Parameters<typeof generateSubnetQuestion>[1]) => generateSubnetQuestion(7, kind);
  const network = q('network');
  assert.ok(checkSubnetAnswer(network, `  ${network.answer}  `));
  assert.ok(checkSubnetAnswer(network, network.answer.split('.').map(o => o.padStart(3, '0')).join('.')), 'leading zeros');
  assert.ok(!checkSubnetAnswer(network, q('broadcast').answer), 'the broadcast address is not the network address');
  assert.ok(!checkSubnetAnswer(network, toDotted(parseDotted(network.answer)! + 1)));
  for (const bad of ['', ' ', 'abc', '10.0.0', '10.0.0.256', '10.0.0.1.2', `${network.answer}/24`]) assert.ok(!checkSubnetAnswer(network, bad), JSON.stringify(bad));

  const hosts = generateSubnetQuestion(1, 'host-count');
  const n = Number(hosts.answer);
  assert.ok(checkSubnetAnswer(hosts, n.toLocaleString('en-US')), 'a thousands comma');
  assert.ok(!checkSubnetAnswer(hosts, String(n + 2)), 'all addresses is not the usable count');
  assert.ok(!checkSubnetAnswer(hosts, `${n} hosts`));

  const prefix = q('prefix');
  assert.ok(checkSubnetAnswer(prefix, prefix.answer) && checkSubnetAnswer(prefix, prefix.answer.slice(1)), '/26 or 26');
  assert.ok(!checkSubnetAnswer(prefix, `/${Number(prefix.answer.slice(1)) + 1}`));
  assert.ok(!checkSubnetAnswer(prefix, q('mask').answer));

  const same = q('same-subnet');
  assert.ok(checkSubnetAnswer(same, same.answer.toUpperCase()) && checkSubnetAnswer(same, same.answer[0]));
  assert.ok(!checkSubnetAnswer(same, same.answer === 'yes' ? 'no' : 'yes'));
  assert.ok(!checkSubnetAnswer(same, 'maybe'));
});
