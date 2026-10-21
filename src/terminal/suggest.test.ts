import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { linuxSession, windowsSession } from './testUtils.ts';
import { closestName, editDistance, suggestCmd, suggestLinux, suggestPowerShell } from './suggest.ts';

describe('editDistance', () => {
  it('counts insertions, deletions, substitutions and neighbour swaps as one edit each', () => {
    assert.equal(editDistance('grep', 'grep'), 0);
    assert.equal(editDistance('grpe', 'grep'), 1);
    assert.equal(editDistance('sl', 'ls'), 1);
    assert.equal(editDistance('lsmod', 'lsmodx'), 1);
    assert.equal(editDistance('chmod', 'chmd'), 1);
    assert.equal(editDistance('cat', 'dog'), 3);
  });
});

describe('closestName', () => {
  it('suggests only within distance 2, and 1 for short names', () => {
    assert.equal(closestName('grpe', ['grep', 'cat']), 'grep');
    assert.equal(closestName('gxxpz', ['grep']), undefined);
    assert.equal(closestName('cta', ['cat']), 'cat');
    assert.equal(closestName('cxx', ['cat']), undefined);
  });

  it('needs a swap or a case change for one or two letters', () => {
    assert.equal(closestName('sl', ['ls', 'su']), 'ls');
    assert.equal(closestName('lx', ['ls']), undefined);
  });

  it('never suggests for paths or the name itself', () => {
    assert.equal(closestName('./scirpt.sh', ['script.sh']), undefined);
    assert.equal(closestName('/bin/lss', ['ls']), undefined);
    assert.equal(closestName('dir', ['DIR'], false), undefined);
  });
});

describe('suggestions', () => {
  it('bash: close misspellings of lab commands', () => {
    assert.equal(suggestLinux('grpe'), 'There is no command named grpe. Did you mean grep?');
    assert.ok(suggestLinux('lspic')?.includes('Did you mean lspci?'), String(suggestLinux('lspic')));
    assert.ok(suggestLinux('dmseg')?.includes('Did you mean dmesg?'), String(suggestLinux('dmseg')));
    assert.ok(suggestLinux('ehco')?.includes('Did you mean echo?'), String(suggestLinux('ehco')));
    assert.equal(suggestLinux('LS'), 'There is no command named LS. Did you mean ls? Command names in bash are case-sensitive.');
    assert.equal(suggestLinux('xyzzy'), undefined);
  });

  it('CMD and PowerShell: close misspellings, in the documented spelling', () => {
    assert.equal(suggestCmd('ipconfg'), 'There is no command named ipconfg. Did you mean ipconfig?');
    assert.ok(suggestCmd('tasklst')?.includes('Did you mean tasklist?'), String(suggestCmd('tasklst')));
    assert.equal(suggestCmd('xyzzy'), undefined);
    assert.equal(suggestPowerShell('get-servic'), 'There is no command named get-servic. Did you mean Get-Service?');
    assert.ok(suggestPowerShell('Unlock-ADAcount')?.includes('Did you mean Unlock-ADAccount?'), String(suggestPowerShell('Unlock-ADAcount')));
    assert.ok(suggestPowerShell('ipconfg')?.includes('Did you mean ipconfig?'), String(suggestPowerShell('ipconfg')));
    assert.equal(suggestPowerShell('xyzzy'), undefined);
  });
});

describe('the suggestion goes only in the explanation note', () => {
  it('bash: stdout, stderr and exit code are exactly what bash prints', () => {
    const run = linuxSession();
    const res = run('grpe e1000e /proc/modules');
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, 'bash: grpe: command not found');
    assert.equal(res.exitCode, 127);
    assert.equal(res.explanation, 'There is no command named grpe. Did you mean grep?');

    const none = run('xyzzy');
    assert.equal(none.stderr, 'bash: xyzzy: command not found');
    assert.equal(none.exitCode, 127);
    assert.equal(none.explanation, undefined);
  });

  it('bash: in a pipeline the output is unchanged and the note is kept', () => {
    const res = linuxSession()('lsmdo | grep e1000e');
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, 'bash: lsmdo: command not found');
    assert.ok(res.explanation?.includes('Did you mean lsmod?'), String(res.explanation));
  });

  it('bash: a real command that is not simulated keeps its own message and gets no suggestion', () => {
    const res = linuxSession()('vim notes.txt');
    assert.equal(res.stderr, 'bash: vim: this command exists on real systems but is not simulated here');
    assert.equal(res.exitCode, 127);
    assert.equal(res.explanation, undefined);
  });

  it('CMD: the not-recognized message is unchanged', () => {
    const run = windowsSession('cmd');
    const res = run('ipconfg /all');
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, "'ipconfg' is not recognized as an internal or external command,\noperable program or batch file.");
    assert.equal(res.exitCode, 9009);
    assert.equal(res.explanation, 'There is no command named ipconfg. Did you mean ipconfig?');

    const none = run('xyzzy');
    assert.equal(none.stderr, "'xyzzy' is not recognized as an internal or external command,\noperable program or batch file.");
    assert.equal(none.explanation, undefined);

    const notSim = run('robocopy a b');
    assert.equal(notSim.stderr, "'robocopy' exists on real Windows but is not simulated here.");
    assert.equal(notSim.explanation, undefined);
  });

  it('PowerShell: the not-recognized error block is unchanged', () => {
    const run = windowsSession('powershell');
    const res = run('Get-Servce W32Time');
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, [
      "Get-Servce : The term 'Get-Servce' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.",
      'At line:1 char:1',
      '+ Get-Servce W32Time',
      '+ ~~~~~~~~~~',
      '    + CategoryInfo          : ObjectNotFound: (Get-Servce:String) [], CommandNotFoundException',
      '    + FullyQualifiedErrorId : CommandNotFoundException',
    ].join('\n'));
    assert.equal(res.exitCode, 1);
    assert.equal(res.explanation, 'There is no command named Get-Servce. Did you mean Get-Service?');

    const none = run('xyzzy');
    assert.equal(none.stderr.split('\n')[0], "xyzzy : The term 'xyzzy' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.");
    assert.equal(none.explanation, undefined);

    const notSim = run('Get-Date');
    assert.equal(notSim.stderr, "Get-Date : 'Get-Date' exists on real Windows but is not simulated here.");
    assert.equal(notSim.explanation, undefined);
  });
});
