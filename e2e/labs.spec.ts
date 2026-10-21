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
