import { test, expect, expectNoHorizontalOverflow, runCommand, showLab, showTerminal, terminalLog } from './fixtures';
import { CHALLENGES, todaysPick } from '../src/data/challenges';

test('the challenge list highlights today\'s pick and keeps every challenge open', async ({ page }) => {
  await page.goto('#/sandbox/challenge');
  await expect(page.getByRole('heading', { level: 1, name: 'Challenges' })).toBeVisible();
  await expect(page).toHaveTitle(/^Challenges · Sandbox · Terminus CertSim$/);

  const pick = page.getByRole('region', { name: 'Today’s pick' });
  await expect(pick).toContainText(todaysPick().title);
  await expect(pick.getByRole('link', { name: 'Start this challenge' })).toHaveAttribute('href', `#/sandbox/challenge/${todaysPick().id}`);

  const all = page.getByRole('region', { name: 'All challenges' });
  await expect(all.getByRole('link')).toHaveCount(CHALLENGES.length);
  // Nothing expires and nothing is missed
  await expect(page.getByText(/missed|expire|streak|tomorrow/i)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('a challenge: a wrong answer does not pass, the hint helps, the right one shows the explanation', async ({ page }) => {
  await page.goto('#/sandbox/challenge/bash-login-shells');
  await expect(page.getByRole('heading', { level: 1, name: 'Accounts that use bash' })).toBeVisible();
  await expect(page).toHaveTitle(/^Accounts that use bash · Challenges/);
  await expect(page.getByText('How many accounts on this server log in with /bin/bash?')).toBeVisible();

  // Prints the right lines, but not just the number
  await runCommand(page, 'cat /etc/passwd');
  await runCommand(page, 'echo 2');
  await expect(page.getByRole('heading', { name: 'Solved' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Show hint' }).click();
  await expect(page.getByText(/grep -c counts matching lines/)).toBeVisible();

  await runCommand(page, 'grep -c /bin/bash /etc/passwd');
  await expect(page.getByRole('heading', { level: 2, name: 'Solved' })).toBeVisible();
  await expect(page.getByText(/Two accounts, root and student/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Solved');
  await expectNoHorizontalOverflow(page);

  // The next challenge, and the list remembers this one
  const next = CHALLENGES[CHALLENGES.findIndex(c => c.id === 'bash-login-shells') + 1];
  await page.getByRole('link', { name: next.title }).click();
  await expect(page.getByRole('heading', { level: 1, name: next.title })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Solved' })).toHaveCount(0);

  await page.goto('#/sandbox/challenge');
  await expect(page.getByRole('link', { name: /Accounts that use bash/ })).toContainText('Solved');
  await expect(page.getByText(`1 of ${CHALLENGES.length} solved`)).toBeVisible();
});

test('a Command Prompt challenge in two steps', async ({ page }) => {
  await page.goto('#/sandbox/challenge/cmd-port-4444-program');
  await expect(page.getByRole('heading', { level: 1, name: 'The program on port 4444' })).toBeVisible();
  await runCommand(page, 'tasklist');
  await runCommand(page, 'netstat -ano | findstr 4444');
  await expect(terminalLog(page)).toContainText('3892');
  await expect(page.getByRole('heading', { level: 2, name: 'Solved' })).toHaveCount(0);
  await runCommand(page, 'tasklist /fi "PID eq 3892"');
  await expect(page.getByRole('heading', { level: 2, name: 'Solved' })).toBeVisible();
  await expect(page.getByText(/svchost_update\.exe, PID 3892/)).toBeVisible();
});

test('Reset machine starts a fresh attempt at a solved challenge', async ({ page }) => {
  await page.goto('#/sandbox/challenge/bash-login-shells');
  await runCommand(page, 'grep -c /bin/bash /etc/passwd');
  await expect(page.getByRole('heading', { level: 2, name: 'Solved' })).toBeVisible();

  await page.getByRole('button', { name: 'Reset machine' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Solved' })).toHaveCount(0);
  // The list still remembers it was solved before
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Solved');

  // A wrong answer does not pass, and the right one solves it again
  await runCommand(page, 'echo 2');
  await expect(page.getByRole('heading', { level: 2, name: 'Solved' })).toHaveCount(0);
  await runCommand(page, 'grep -c /bin/bash /etc/passwd');
  await expect(page.getByRole('heading', { level: 2, name: 'Solved' })).toBeVisible();
});

test('an unknown challenge id falls back to the list', async ({ page }) => {
  await page.goto('#/sandbox/challenge/no-such-challenge');
  await expect(page).toHaveURL(/#\/sandbox\/challenge$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Challenges' })).toBeVisible();
});

test('a lab shows its help-desk ticket, and the recap closes it with thanks and offers a challenge', async ({ page }) => {
  await page.goto('#/linux/lpi-101-1-system-architecture');
  await expect(page.getByText('Ticket from Aiko Tanaka, Warehouse')).toBeVisible();
  await expect(page.getByText(/The new server for the warehouse scanners has just arrived/)).toBeVisible();

  await showTerminal(page);
  for (const command of ['lspci', 'lsmod | grep e1000e', 'dmesg | grep -i sata']) await runCommand(page, command);
  await showLab(page);
  await expect(page.getByText('Ticket closed')).toBeVisible();
  await expect(page.getByText('Thanks, the scanners move onto it tomorrow.')).toBeVisible();
  await page.getByRole('link', { name: 'Listening ports' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Listening ports' })).toBeVisible();
});
