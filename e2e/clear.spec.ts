import { test, expect, commandInput, runCommand, showTerminal, terminalLog } from './fixtures';

const BANNER = 'Welcome to Ubuntu 22.04.3 LTS';

test('typed clear wipes the login banner too; Reset lab brings it back', async ({ page }) => {
  await page.goto('#/linux/lpi-104-5-permissions');
  await showTerminal(page);
  const log = terminalLog(page);
  await expect(log).toContainText(BANNER);

  await runCommand(page, 'pwd');
  const input = commandInput(page);
  await input.fill('clear');
  await input.press('Enter');
  await expect(log).not.toContainText('pwd');
  await expect(log).not.toContainText(BANNER);

  await page.getByRole('button', { name: 'Reset lab' }).click();
  await expect(log).toContainText(BANNER);

  // clear as the first command of a fresh machine, with output after it
  await runCommand(page, 'clear; echo hi');
  await expect(log).not.toContainText(BANNER);

  await page.getByRole('button', { name: 'Reset lab' }).click();
  await expect(log).toContainText(BANNER);
  await expect(log).not.toContainText('echo hi');
});

test('sandbox: clear wipes the banner and Reset shows it again', async ({ page }) => {
  await page.goto('#/sandbox');
  const log = terminalLog(page);
  await expect(log).toContainText(BANNER);
  await runCommand(page, 'ls');
  await commandInput(page).fill('clear');
  await commandInput(page).press('Enter');
  await expect(log).not.toContainText(BANNER);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(log).toContainText(BANNER);
});
