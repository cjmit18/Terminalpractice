import {
  test,
  expect,
  commandInput,
  headerProgress,
  readHeaderProgress,
  runCommand,
  showLab,
  showTerminal,
  terminalLog,
} from './fixtures';

const PERMISSIONS_LAB = '#/linux/lpi-104-5-permissions';
const DISKPART_LAB = '#/windows/win-pbq-diskpart-partitioning';

test('permissions lab: typed commands complete every task, progress persists and can be reset', async ({ page }) => {
  await page.goto(PERMISSIONS_LAB);
  await expect(page.getByRole('heading', { level: 1, name: 'Manage file permissions and ownership' })).toBeVisible();
  const before = await readHeaderProgress(page);
  expect(before.done).toBe(0);

  await showTerminal(page);
  for (const command of [
    'ls -ld /home/student/finance',
    'chmod 750 /home/student/finance',
    'sudo chown root:finance /home/student/finance',
    'umask 027',
  ]) {
    await runCommand(page, command);
  }
  await expect(terminalLog(page)).toContainText('drwxrwxrwx');

  // The header total and the lab's own count both move to 4
  await expect(headerProgress(page)).toHaveText(new RegExp(`^4 of ${before.total} (tasks )?done$`));
  await showLab(page);
  await expect(page.getByText('4 of 4 done')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Done');

  // Progress is saved in this browser
  await page.reload();
  await expect(headerProgress(page)).toHaveText(new RegExp(`^4 of ${before.total} (tasks )?done$`));
  await expect(page.getByText('4 of 4 done')).toBeVisible();

  // Reset it from the catalog, accepting the confirm dialog
  await page.goto('#/linux');
  const lab = page.getByRole('link', { name: /Manage file permissions and ownership/ });
  await expect(lab).toContainText('Done');
  page.once('dialog', dialog => {
    expect(dialog.type()).toBe('confirm');
    void dialog.accept();
  });
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await expect(headerProgress(page)).toHaveText(new RegExp(`^0 of ${before.total} (tasks )?done$`));
  await expect(lab).toContainText('0 of 4 tasks');
  await expect(page.getByRole('button', { name: 'Reset progress' })).toBeHidden();

  await page.reload();
  await expect(headerProgress(page)).toHaveText(new RegExp(`^0 of ${before.total} (tasks )?done$`));
});

test('DiskPart lab: running every walkthrough step completes the lab', async ({ page }) => {
  await page.goto(DISKPART_LAB);
  await page.getByRole('tab', { name: 'Walkthrough' }).click();

  const runButtons = page.getByRole('button', { name: /^Run step \d+/ });
  await expect(runButtons).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await runButtons.nth(i).click();
  }
  await expect(page.getByText('Sent to the terminal')).toHaveCount(4);

  await page.getByRole('tab', { name: 'Tasks' }).click();
  await expect(page.getByText('4 of 4 done')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Done');

  // The commands went to the terminal and diskpart answered
  await showTerminal(page);
  await expect(terminalLog(page)).toContainText('assign letter=E');
  await expect(terminalLog(page)).toContainText('DiskPart successfully assigned the drive letter');
});

test('a permission error explains why', async ({ page }) => {
  await page.goto(PERMISSIONS_LAB);
  await showTerminal(page);
  await runCommand(page, 'cat /etc/shadow');
  const log = terminalLog(page);
  await expect(log).toContainText('Permission denied');
  await expect(log.getByText('Why:')).toBeVisible();
  await expect(commandInput(page)).toBeFocused();
});

test('keyboard users can Tab out of the terminal prompt', async ({ page, isMobile }) => {
  // Tab completes a partly typed command name; Shift+Tab (and Tab on an empty line) must leave the prompt
  test.skip(isMobile, 'keyboard navigation');
  await page.goto(PERMISSIONS_LAB);
  await expect(commandInput(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(commandInput(page)).not.toBeFocused();
});

test('walkthrough steps run in the shell they are written for', async ({ page, isMobile }) => {
  // Walkthrough steps are written for the lab's default shell, even if the header picked the other one
  test.skip(isMobile, 'same code path on both projects');
  await page.goto('#/windows/win-pbq-active-directory-mgmt');
  await page.getByRole('group', { name: 'Shell' }).filter({ visible: true }).getByRole('button', { name: 'Command Prompt' }).click();
  await page.getByRole('tab', { name: 'Walkthrough' }).click();
  await page.getByRole('button', { name: /^Run step 1/ }).click();
  await expect(terminalLog(page)).not.toContainText('is not recognized');
  await page.getByRole('tab', { name: 'Tasks' }).click();
  await expect(page.getByText('1 of 3 done')).toBeVisible();
});

test('clear in a command chain keeps the output that comes after it', async ({ page }) => {
  await page.goto(PERMISSIONS_LAB);
  await showTerminal(page);
  await runCommand(page, 'echo before');
  await runCommand(page, 'clear; echo hello; cat missing-file');
  await expect(terminalLog(page)).not.toContainText('before');
  await expect(terminalLog(page)).toContainText('hello');
  await expect(terminalLog(page)).toContainText('missing-file: No such file or directory');
});
