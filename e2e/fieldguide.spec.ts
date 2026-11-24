import type { Page } from '@playwright/test';
import { test, expect, runCommand, commandInput, expectNoHorizontalOverflow } from './fixtures';

const entry = (page: Page, name: string) => page.locator(`[data-guide-entry="${name}"]`);

async function openGuide(page: Page) {
  await page.goto('#/reference');
  // Phones show one pane at a time; the view switch is on the list
  const back = page.getByRole('button', { name: 'All commands' });
  if (await back.isVisible()) await back.click();
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Your field guide' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your field guide' })).toBeVisible();
}

test('field guide: seen, ran and read ticks; unmet commands by name only; counts per area', async ({ page }) => {
  await page.goto('#/sandbox');
  await runCommand(page, 'pwd');
  await openGuide(page);

  // Seen in a lesson only
  await expect(entry(page, 'grep')).toHaveAttribute('data-met', 'true');
  await expect(entry(page, 'grep')).toContainText('Seen in a lesson: yes');
  await expect(entry(page, 'grep')).toContainText('Ran it: not yet');
  // Ran it in the Sandbox, never in a lesson
  await expect(entry(page, 'pwd')).toContainText('Ran it: yes');
  await expect(entry(page, 'pwd')).toContainText('Seen in a lesson: not yet');
  // Not met yet: the name and nothing else
  await expect(entry(page, 'nl')).toHaveAttribute('data-met', 'false');
  await expect(entry(page, 'nl')).toHaveText('nl');
  // Counts per area, in words
  await expect(page.getByRole('heading', { name: /^Text tools: \d+ of \d+ met$/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Reading the manual here ticks it
  await entry(page, 'pwd').getByRole('button', { name: 'Read the manual' }).click();
  await expect(entry(page, 'pwd')).toContainText('PWD(1)');
  await expect(entry(page, 'pwd')).toContainText('Read its manual: yes');

  // Other shells
  await page.getByRole('radiogroup', { name: 'Shell' }).getByRole('radio', { name: 'PowerShell' }).click();
  await expect(page.getByRole('heading', { name: /^Active Directory: \d+ of \d+ met$/ })).toBeVisible();
});

test('field guide: Try it in the Sandbox offers the command, and the Reference page link opens the entry', async ({ page }) => {
  await openGuide(page);
  await entry(page, 'grep').getByRole('button', { name: 'Reference page' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'grep', exact: true })).toBeVisible();

  await openGuide(page);
  await entry(page, 'wc').getByRole('button', { name: 'Try it in the Sandbox' }).click();
  await expect(page).toHaveURL(/#\/sandbox$/);
  const tryRow = page.getByText('Try:', { exact: true }).locator('..');
  await expect(tryRow.getByRole('button').first()).toHaveText('wc');
  await tryRow.getByRole('button', { name: 'wc', exact: true }).click();
  await expect(commandInput(page)).toHaveValue('wc');
});

test('the Sandbox header on a narrow screen: the title, description and buttons do not overlap', async ({ page }) => {
  // 360px is the narrowest common phone. A finished lab shows "Your machine" too: the most buttons the header carries
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('#/sandbox');
  await page.evaluate(() => {
    localStorage.setItem('certsim:progress:v1', JSON.stringify({ 'lpi-101-1-system-architecture': ['hw-lspci', 'hw-lsmod', 'hw-dmesg'] }));
  });
  await page.reload();
  const header = page.locator('header').filter({ has: page.getByRole('heading', { name: 'Sandbox', level: 1 }) });
  const title = await header.getByRole('heading', { name: 'Sandbox', level: 1 }).boundingBox();
  const meta = await header.getByText('A practice machine with no tasks.').boundingBox();
  const buttons = [header.getByRole('link', { name: 'Challenges' }), header.getByRole('button', { name: 'Your machine' }), header.getByRole('button', { name: 'Files' }), header.getByRole('button', { name: 'Reset' })];
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const button of buttons) {
    const box = (await button.boundingBox())!;
    expect(overlaps(title!, box), `the title overlaps ${await button.textContent()}`).toBe(false);
    expect(overlaps(meta!, box), `the description overlaps ${await button.textContent()}`).toBe(false);
  }
  // The title's text fits its box, rather than spilling onto the buttons beside it
  expect(await header.getByRole('heading', { name: 'Sandbox', level: 1 }).evaluate(h => h.scrollWidth <= h.clientWidth)).toBe(true);
  // The description reads as a line or two, not one word a line (seen on a phone)
  expect(meta!.height).toBeLessThan(60);
  await expectNoHorizontalOverflow(page);
});

test('sandbox looks: nothing to choose at first; a finished lab, stage and path unlock name, prompt and banner', async ({ page }) => {
  await page.goto('#/sandbox');
  await expect(page.getByRole('button', { name: 'Your machine' })).toHaveCount(0);

  // First lab done (and a stage and a path, through earned badges kept from before)
  await page.evaluate(() => {
    localStorage.setItem('certsim:progress:v1', JSON.stringify({ 'lpi-101-1-system-architecture': ['hw-lspci', 'hw-lsmod', 'hw-dmesg'] }));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Your machine' }).click();
  const panel = page.getByRole('complementary', { name: 'Your machine' });
  await expect(panel.getByText('Finish a stage of any path to choose a prompt format.')).toBeVisible();
  await expect(panel.getByText('Finish a whole path to add a line to the login banner.')).toBeVisible();

  await panel.getByRole('textbox').fill('Bad Name!');
  await panel.getByRole('button', { name: 'Save name' }).click();
  await expect(panel.getByText(/Use lower-case letters/)).toBeVisible();
  await panel.getByRole('textbox').fill('lab-box');
  await panel.getByRole('button', { name: 'Save name' }).click();
  await page.getByRole('button', { name: 'Close your machine settings' }).click();
  await runCommand(page, 'hostname');
  await expect(page.getByRole('log', { name: 'Terminal output' })).toContainText('student@lab-box');

  // A stage and a path: badges earned before stay earned, so the looks stay too
  await page.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('certsim:activity:v1') ?? '{}');
    a.badges = { ...a.badges, 'stage-clear': 1, 'path:lpic1-101': 1 };
    localStorage.setItem('certsim:activity:v1', JSON.stringify(a));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Your machine' }).click();
  await panel.getByRole('radio', { name: '[student@lab-box ~]$' }).check();
  await panel.getByRole('radio', { name: 'Nothing on this machine can break. Try anything.' }).check();
  await page.getByRole('button', { name: 'Close your machine settings' }).click();
  await page.getByRole('button', { name: 'Reset' }).click();
  const log = page.getByRole('log', { name: 'Terminal output' });
  await expect(log).toContainText('Nothing on this machine can break. Try anything.');
  await runCommand(page, 'echo hi');
  await expect(log).toContainText('[student@lab-box ~]$');
});
