import test from 'node:test';
import assert from 'node:assert/strict';
import { NETPLUS_PORTS, PORT_KINDS, checkPortAnswer, generatePortQuestion } from './ports.ts';
import { OBJECTIVES_BY_ID } from '../../data/examObjectives.ts';

test('ports table: exactly the 20 entries of N10-009 objective 1.4, with their ports', () => {
  // Copied from the official PDF (Exam Objectives version 4.0), one line per row as printed there
  const official: [string, string][] = [
    ['File Transfer Protocol', '20/21'], ['Secure File Transfer Protocol', '22'], ['Secure Shell', '22'], ['Telnet', '23'],
    ['Simple Mail Transfer Protocol', '25'], ['Domain Name System', '53'], ['Dynamic Host Configuration Protocol', '67/68'],
    ['Trivial File Transfer Protocol', '69'], ['Hypertext Transfer Protocol', '80'], ['Network Time Protocol', '123'],
    ['Simple Network Management Protocol', '161/162'], ['Lightweight Directory Access Protocol', '389'],
    ['Hypertext Transfer Protocol Secure', '443'], ['Server Message Block', '445'], ['Syslog', '514'],
    ['Simple Mail Transfer Protocol Secure', '587'], ['Lightweight Directory Access Protocol over SSL', '636'],
    ['Structured Query Language (SQL) Server', '1433'], ['Remote Desktop Protocol', '3389'], ['Session Initiation Protocol', '5060/5061'],
  ];
  assert.deepEqual(NETPLUS_PORTS.map(p => [p.full, p.ports.join('/')]), official);
  // Transport is given only where it is clear-cut
  for (const name of ['HTTPS', 'LDAP', 'RDP', 'SIP']) assert.equal(NETPLUS_PORTS.find(p => p.name === name)?.transport, undefined, name);
  assert.equal(NETPLUS_PORTS.find(p => p.name === 'DNS')?.transport, 'both');
});

test('ports drills: 3,000 seeds give right, answerable questions of every kind', () => {
  const kinds = new Map<string, number>();
  const prompts = new Set<string>();
  for (let seed = 0; seed < 3000; seed++) {
    const q = generatePortQuestion(seed * 7919 + 5);
    assert.ok(checkPortAnswer(q, q.answer), `seed ${q.seed}: its own answer "${q.answer}" is accepted for "${q.prompt}"`);
    assert.ok(q.explanation.length > 20);
    for (const id of q.objectives) assert.ok(OBJECTIVES_BY_ID.has(id), id);
    kinds.set(q.kind, (kinds.get(q.kind) ?? 0) + 1);
    prompts.add(q.prompt);
    // The answer agrees with the table, worked out here the plain way
    if (q.kind === 'port') {
      const p = NETPLUS_PORTS.find(x => q.prompt.includes(` ${x.name} use?`))!;
      assert.equal(q.answer.replace(' and ', ',').split(',').map(Number).join('/'), p.ports.join('/'), q.prompt);
    } else if (q.kind === 'protocol') {
      const port = Number(/port (\d+)\?/.exec(q.prompt)![1]);
      const owners = NETPLUS_PORTS.filter(x => x.ports.includes(port)).map(x => x.name);
      assert.deepEqual(q.answer.split(' or '), owners, q.prompt);
    } else {
      const p = NETPLUS_PORTS.find(x => q.prompt.startsWith(`Does ${x.name} use`))!;
      assert.ok(p.transport, `${p.name} has a clear-cut transport`);
    }
  }
  for (const kind of PORT_KINDS) assert.ok((kinds.get(kind) ?? 0) > 700, `${kind}: ${kinds.get(kind)}`);
  // 20 protocols, 24 port numbers and 16 clear-cut transports: 60 questions in all
  assert.ok(prompts.size >= 55, `nearly all 60 questions turn up: ${prompts.size}`);
  assert.deepEqual(generatePortQuestion(42), generatePortQuestion(42), 'a seed always gives the same question');
});

test('ports drills: the checker takes the usual ways to answer and refuses near misses', () => {
  const portOf = (name: string) => {
    for (let s = 0; ; s++) {
      const q = generatePortQuestion(s, 'port');
      if (q.prompt.includes(` ${name} use?`)) return q;
    }
  };
  const ftp = portOf('FTP');
  for (const ok of ['20/21', '21/20', '20, 21', '20 and 21', '20 21', ' 21 & 20 ']) assert.ok(checkPortAnswer(ftp, ok), ok);
  for (const bad of ['21', '20', '20/21/22', '20/20', 'twenty', '20-21', '']) assert.ok(!checkPortAnswer(ftp, bad), JSON.stringify(bad));
  const ssh = portOf('SSH');
  assert.ok(checkPortAnswer(ssh, '22') && !checkPortAnswer(ssh, '23') && !checkPortAnswer(ssh, '022/22'));

  const protocolAt = (port: number) => {
    for (let s = 0; ; s++) {
      const q = generatePortQuestion(s, 'protocol');
      if (q.prompt === `Which protocol uses port ${port}?`) return q;
    }
  };
  const p22 = protocolAt(22);
  assert.equal(p22.answer, 'SFTP or SSH');
  for (const ok of ['ssh', 'SSH', 'Secure Shell', 'sftp', 'Secure File Transfer Protocol', 'SFTP or SSH', 'ssh/sftp']) assert.ok(checkPortAnswer(p22, ok), ok);
  for (const bad of ['telnet', 'ftp', 'ss', 'ssh 22', 'ssh or telnet', 'ssh or ssh']) assert.ok(!checkPortAnswer(p22, bad), bad);
  const p1433 = protocolAt(1433);
  for (const ok of ['SQL Server', 'sqlserver', 'MSSQL', 'Microsoft SQL Server']) assert.ok(checkPortAnswer(p1433, ok), ok);
  const p587 = protocolAt(587);
  assert.ok(checkPortAnswer(p587, 'SMTPS') && checkPortAnswer(p587, 'smtp secure') && !checkPortAnswer(p587, 'smtp'), 'plain SMTP is port 25');
  const p636 = protocolAt(636);
  assert.ok(checkPortAnswer(p636, 'LDAPS') && !checkPortAnswer(p636, 'LDAP'));

  const transportOf = (name: string) => {
    for (let s = 0; ; s++) {
      const q = generatePortQuestion(s, 'transport');
      if (q.prompt.startsWith(`Does ${name} use`)) return q;
    }
  };
  const dns = transportOf('DNS');
  for (const ok of ['both', 'Both', 'TCP and UDP', 'udp/tcp', 'tcp & udp']) assert.ok(checkPortAnswer(dns, ok), ok);
  assert.ok(!checkPortAnswer(dns, 'udp') && !checkPortAnswer(dns, 'tcp'));
  const ntp = transportOf('NTP');
  assert.ok(checkPortAnswer(ntp, 'UDP') && checkPortAnswer(ntp, 'udp') && !checkPortAnswer(ntp, 'tcp') && !checkPortAnswer(ntp, 'both'));
});

test('ports drills: a hint points the way without giving the answer', () => {
  for (let seed = 0; seed < 3000; seed++) {
    const q = generatePortQuestion(seed * 104729 + 3);
    assert.ok(q.hint.length > 20, q.prompt);
    if (q.kind === 'port') {
      for (const port of q.answer.split(/, | and /)) assert.ok(!new RegExp(`\\b${port}\\b`).test(q.hint), `${q.prompt} / ${q.hint}`);
    } else if (q.kind === 'protocol') {
      for (const name of q.answer.split(' or ')) {
        const p = NETPLUS_PORTS.find(x => x.name === name)!;
        for (const n of [p.name, p.full]) assert.ok(!q.hint.toLowerCase().includes(n.toLowerCase()), `${q.prompt} / ${q.hint}`);
      }
    } else {
      assert.ok(!/\b(only|over) (TCP|UDP)\b|\bboth\b/.test(q.hint), `${q.prompt} / ${q.hint}`);
    }
  }
});
