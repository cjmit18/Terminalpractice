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

test('the Drills tab: a generated subnetting question, checked, explained, then a new one', async ({ page }) => {
  const { generateSubnetQuestion } = await import('../src/lib/drills/subnet');
  await page.goto('#/sandbox/challenge');
  const tabs = page.getByRole('navigation', { name: 'Quick practice' });
  await expect(tabs.getByRole('link', { name: 'Challenges' })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: 'Drills' }).click();
  await expect(page).toHaveURL(/#\/sandbox\/drills$/);
  await expect(page).toHaveTitle(/^Drills · Challenges · Sandbox · Terminus CertSim$/);
  await expect(tabs.getByRole('link', { name: 'Drills' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 2, name: 'Subnetting' })).toBeVisible();

  // The page says which seed made the question, so the test can work out the same answer
  const form = page.locator('form[data-seed]');
  const questionNow = async () => generateSubnetQuestion(Number(await form.getAttribute('data-seed')));
  const first = await questionNow();
  const box = page.getByRole('textbox', { name: first.prompt });
  await expect(box).toBeVisible();

  // Nothing typed: a nudge, and nothing counted
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText('Type an answer first.')).toBeVisible();
  await expect(page.getByText(/right this visit/)).toHaveCount(0);

  // A wrong answer shows the right one and how it is worked out
  await box.fill('not an answer');
  await box.press('Enter');
  const feedback = form.getByRole('status');
  await expect(feedback).toContainText('Not quite.');
  await expect(feedback).toContainText(`The answer is ${first.answer}.`);
  await expect(feedback).toContainText(first.explanation);
  await expect(feedback).toBeFocused();
  await expect(page.getByText('0 of 1 right this visit')).toBeVisible();

  // Next question: new numbers, the box is empty and focused; the right answer counts
  await page.getByRole('button', { name: 'Next question' }).click();
  const second = await questionNow();
  expect(second.seed).not.toBe(first.seed);
  const box2 = page.getByRole('textbox', { name: second.prompt });
  await expect(box2).toBeFocused();
  await expect(box2).toHaveValue('');
  await box2.fill(second.answer);
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(feedback).toContainText('Correct.');
  await expect(page.getByText('1 of 2 right this visit')).toBeVisible();
  await expect(page.getByText(/streak|score|missed/i)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // Back goes to the Challenges tab
  await page.goBack();
  await expect(page.getByRole('region', { name: 'Today’s pick' })).toBeVisible();
});
