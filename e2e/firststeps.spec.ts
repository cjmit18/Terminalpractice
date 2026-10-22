import type { Page } from '@playwright/test';
import { test, expect, commandInput, terminalLog } from './fixtures';

const BANNER_HEADING = 'New to the command line? Start here (5 minutes)';
const BASH_LAB_STEP = '#/learn/first-steps/lab-first-steps-linux';

const banner = (page: Page) => page.getByRole('region', { name: BANNER_HEADING });

test.describe('first steps offer on the Learn page', () => {

  test('a new learner is offered the first steps, and Begin opens the first lesson', async ({ page }) => {
    await page.goto('#/learn');
    await expect(banner(page)).toBeVisible();
    await banner(page).getByRole('link', { name: 'Begin' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'What the prompt means' })).toBeVisible();

    // Opening the path counts as progress, so the offer gives way to "Continue where you left off"
    await page.goto('#/learn');
    await expect(page.getByText('Continue where you left off:')).toBeVisible();
    await expect(banner(page)).toBeHidden();
  });

  test('"I\'ve used a terminal before" hides the offer and it stays hidden', async ({ page }) => {
    await page.goto('#/learn');
    await banner(page).getByRole('button', { name: "I've used a terminal before" }).click();
    await expect(banner(page)).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('certsim:firststeps-dismissed'))).toBe('1');

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Learning paths' })).toBeVisible();
    await expect(banner(page)).toBeHidden();
    // The path itself is still listed for anyone who wants it later
    await expect(page.getByRole('heading', { level: 2, name: 'Your first terminal' })).toBeVisible();
  });

  test('someone with saved progress is not offered the first steps', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('certsim:journey:v1', JSON.stringify({ read: ['lpic1-101/how-linux-sees-hardware'], quiz: {}, last: null }));
    });
    await page.goto('#/learn');
    await expect(page.getByRole('heading', { level: 1, name: 'Learning paths' })).toBeVisible();
    await expect(banner(page)).toBeHidden();
  });
});

test.describe('first steps on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout only');

  test('the bash lab can be finished with the phone keyboard and the key toolbar', async ({ page }) => {
    await page.goto(BASH_LAB_STEP);
    const show = page.getByRole('group', { name: 'Show' });
    await show.getByRole('button', { name: 'Terminal' }).tap();

    const input = commandInput(page);
    const keys = page.getByRole('toolbar', { name: 'Terminal keys' });
    await expect(keys).toBeVisible();
    const enter = async (expected: string) => {
      await expect(input).toHaveValue(expected);
      await input.press('Enter');
      await expect(input).toHaveValue('');
      await expect(terminalLog(page)).toContainText(expected.trim());
    };
    await input.tap();

    // 1. pw + Tab completes to pwd
    await input.pressSequentially('pw');
    await keys.getByRole('button', { name: 'Tab, complete command' }).tap();
    await enter('pwd ');
    await expect(terminalLog(page)).toContainText('/home/student');

    // 2. l + Tab extends to ls (ls, lsmod and lspci all start that way)
    await input.pressSequentially('l');
    await keys.getByRole('button', { name: 'Tab, complete command' }).tap();
    await enter('ls');
    await expect(terminalLog(page)).toContainText('welcome.txt');

    // 3. The dot comes from the toolbar
    await input.pressSequentially('cat welcome');
    await keys.getByRole('button', { name: 'Insert .' }).tap();
    await input.pressSequentially('txt');
    await enter('cat welcome.txt');
    await expect(terminalLog(page)).toContainText('cd notes');

    // 4. What welcome.txt says to type next
    await input.pressSequentially('cd notes');
    await enter('cd notes');

    // 5. Two minus signs from the toolbar
    await input.pressSequentially('ls ');
    await keys.getByRole('button', { name: 'Insert -' }).tap();
    await keys.getByRole('button', { name: 'Insert -' }).tap();
    await input.pressSequentially('help');
    await enter('ls --help');

    // The up arrow brings the last command back
    await keys.getByRole('button', { name: 'Previous command' }).tap();
    await expect(input).toHaveValue('ls --help');
    await keys.getByRole('button', { name: 'Control C, cancel line' }).tap();
    await expect(input).toHaveValue('');

    // The lab page's own status bar; the screen-reader Celebrations region can say "Lab done" at the same time
    await expect(page.locator('[role="status"]:not([aria-label="Celebrations"])').filter({ hasText: 'Lab done' })).toBeVisible();
    await show.getByRole('button', { name: /^Lab/ }).tap();
    await expect(show.getByRole('button', { name: /^Lab/ })).toContainText('5 of 5');
  });
});
