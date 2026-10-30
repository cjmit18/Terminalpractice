import { test, expect } from './fixtures';

// #/settings: every setting in one place, reached from the header on every page.

test('the header leads to Settings, which lists every group and fits a phone', async ({ page }) => {
  await page.goto('#/learn');
  // The header keeps no settings of its own
  await expect(page.getByRole('radiogroup', { name: 'Color theme' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Auto save/ })).toHaveCount(0);

  const link = page.getByRole('banner').getByRole('link', { name: 'Settings', exact: true });
  await link.click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(link).toHaveAttribute('aria-current', 'page');
  // Settings is not one of the nav sections, so none of them is marked current
  await expect(page.getByRole('navigation', { name: 'Main' }).locator('[aria-current="page"]')).toHaveCount(0);
  for (const name of ['Appearance', 'Learning', 'Badges and celebrations', 'Your Sandbox machine', 'Saving and your account', 'Your data']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page).toHaveTitle(/^Settings · /);
});

test('terminal text size applies to the terminals and is kept after a reload', async ({ page }) => {
  await page.goto('#/settings');
  const preview = page.getByLabel('Preview');
  const medium = await preview.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  await page.getByRole('group', { name: 'Terminal text size' }).getByRole('radio', { name: 'Large' }).check();
  await expect.poll(() => preview.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(medium);

  await page.goto('#/sandbox');
  const output = page.locator('[data-text-size]');
  await expect(output).toHaveAttribute('data-text-size', 'large');
  await page.reload();
  await expect(output).toHaveAttribute('data-text-size', 'large');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('certsim:activity:v1') ?? '{}').prefs);
  expect(stored).toEqual({ terminalText: 'large' });
});

test('the weekly goal and story notes are set here', async ({ page }) => {
  await page.goto('#/settings');
  await page.getByLabel('Weekly goal').selectOption('3');
  await page.getByRole('group', { name: 'Story notes' }).getByRole('radio', { name: /^Hide/ }).check();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('certsim:activity:v1') ?? '{}').prefs);
  expect(stored).toEqual({ weeklyGoal: 3, storyNotes: false });
});
