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

  // A first miss: a hint and one more try, with the answer still hidden and nothing counted yet
  await box.fill('not an answer');
  await box.press('Enter');
  await expect(form.getByRole('status')).toHaveText('Not quite. Try once more.');
  await expect(form.getByText(`Hint: ${first.hint}`)).toBeVisible();
  await expect(form.getByText(`The answer is`)).toHaveCount(0);
  await expect(box).toBeFocused();
  await expect(page.getByText(/right this visit/)).toHaveCount(0);

  // A second miss shows the right one and how it is worked out
  await box.fill('still not an answer');
  await page.getByRole('button', { name: 'Check again' }).click();
  const feedback = form.getByRole('status');
  await expect(feedback).toContainText('Not quite.');
  await expect(feedback).toContainText(`The answer is ${first.answer}.`);
  await expect(feedback).toContainText(first.explanation);
  await expect(feedback).toBeFocused();
  await expect(page.getByText('0 of 1 right this visit')).toBeVisible();

  // Next question: new numbers, the box is empty and focused; the right answer counts
  await page.getByRole('button', { name: 'Next question' }).click();
  const second = await questionNow();
  expect(second.prompt, 'never the same question twice in a row').not.toBe(first.prompt);
  const box2 = page.getByRole('textbox', { name: second.prompt });
  await expect(box2).toBeFocused();
  await expect(box2).toHaveValue('');
  await box2.fill(second.answer);
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(feedback).toContainText('Correct.');
  await expect(page.getByText('1 of 2 right this visit')).toBeVisible();
  await expect(page.getByText(/streak|score|missed/i)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // A hint on request, then a right answer on the second try counts as right
  await page.getByRole('button', { name: 'Next question' }).click();
  const third = await questionNow();
  const box3 = page.getByRole('textbox', { name: third.prompt });
  await page.getByRole('button', { name: 'Show a hint' }).click();
  await expect(form.getByText(`Hint: ${third.hint}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show a hint' })).toHaveCount(0);
  await box3.fill('wrong');
  await box3.press('Enter');
  await box3.fill(third.answer);
  await box3.press('Enter');
  await expect(feedback).toContainText('Correct, on the second try.');
  await expect(page.getByText('2 of 3 right this visit')).toBeVisible();

  // Skip: a new question, and the skipped one is not counted
  await page.getByRole('button', { name: 'Next question' }).click();
  const fourth = await questionNow();
  await page.getByRole('button', { name: 'Skip this question' }).click();
  const fifth = await questionNow();
  expect(fifth.prompt).not.toBe(fourth.prompt);
  await expect(page.getByRole('textbox', { name: fifth.prompt })).toBeFocused();
  await expect(page.getByText('2 of 3 right this visit')).toBeVisible();

  // Back goes to the Challenges tab
  await page.goBack();
  await expect(page.getByRole('region', { name: 'Today’s pick' })).toBeVisible();
});

test('switching tabs by keyboard keeps focus on the tab just chosen', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard');
  await page.goto('#/sandbox/challenge');
  const tabs = page.getByRole('navigation', { name: 'Quick practice' });
  const drills = tabs.getByRole('link', { name: 'Drills' });
  await drills.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/sandbox\/drills$/);
  await expect(drills).toHaveAttribute('aria-current', 'page');
  await expect(drills).toBeFocused();
  // The next Tab goes on into the drills (the choice of drill comes first), not back to the top of the page
  await page.keyboard.press('Tab');
  await expect(page.getByRole('radio', { name: 'Subnetting' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#drill-answer')).toBeFocused();

  // And back again
  const challenges = tabs.getByRole('link', { name: 'Challenges' });
  await challenges.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Today’s pick' })).toBeVisible();
  await expect(challenges).toBeFocused();
});

test('the ports and protocols drill: chosen on the Drills tab, checked against the Network+ list', async ({ page }) => {
  const { generatePortQuestion } = await import('../src/lib/drills/ports');
  await page.goto('#/sandbox/drills');
  await expect(page.getByRole('radio', { name: 'Subnetting' })).toBeChecked();
  await page.getByRole('radio', { name: 'Ports and protocols' }).check();
  await expect(page.getByRole('heading', { level: 2, name: 'Ports and protocols' })).toBeVisible();
  await expect(page.getByText(/20 ports and protocols on the Network\+ \(N10-009\) objectives/)).toBeVisible();

  const form = page.locator('form[data-seed]');
  const questionNow = async () => generatePortQuestion(Number(await form.getAttribute('data-seed')));
  const first = await questionNow();
  const box = page.getByRole('textbox', { name: first.prompt });
  await box.fill(first.answer);
  await box.press('Enter');
  await expect(form.getByRole('status')).toContainText('Correct.');
  await expect(form.getByRole('status')).toContainText(first.explanation);
  await expect(page.getByText('1 of 1 right this visit')).toBeVisible();

  await page.getByRole('button', { name: 'Next question' }).click();
  const second = await questionNow();
  expect(second.prompt).not.toBe(first.prompt);
  const portBox = page.getByRole('textbox', { name: second.prompt });
  await portBox.fill('not a port');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(form.getByText(`Hint: ${second.hint}`)).toBeVisible();
  await portBox.fill('still not a port');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(form.getByRole('status')).toContainText('Not quite.');
  await expect(form.getByRole('status')).toContainText(`The answer is ${second.answer}.`);

  // Switching back starts subnetting afresh, with its own count
  await page.getByRole('radio', { name: 'Subnetting' }).check();
  await expect(page.getByRole('heading', { level: 2, name: 'Subnetting' })).toBeVisible();
  await expect(page.getByText(/right this visit/)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
