import { test as base, expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared test setup: every test fails if the page logs a console error or throws,
 * unless it opts out with `test.use({ allowConsoleErrors: true })`.
 */
export const test = base.extend<{ allowConsoleErrors: boolean; consoleErrors: string[] }>({
  allowConsoleErrors: [false, { option: true }],
  consoleErrors: [
    async ({ page, allowConsoleErrors }, use) => {
      const errors: string[] = [];
      page.on('console', msg => {
        if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
      });
      page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
      await use(errors);
      if (!allowConsoleErrors) expect(errors, 'console errors on the page').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The header's overall count, e.g. "4 of 37 tasks done" (desktop) or "4 of 37 done" (phone). */
export const headerProgress = (page: Page): Locator =>
  page.getByRole('banner').getByText(/^\d+ of \d+ (tasks )?done$/);

export async function readHeaderProgress(page: Page): Promise<{ done: number; total: number }> {
  const text = (await headerProgress(page).textContent()) ?? '';
  const m = text.match(/(\d+) of (\d+)/);
  if (!m) throw new Error(`Unexpected header progress text: "${text}"`);
  return { done: Number(m[1]), total: Number(m[2]) };
}

/** On phones a lab shows one pane at a time; switch to the terminal pane if the switch is there. */
export async function showTerminal(page: Page): Promise<void> {
  const terminalSwitch = page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Terminal' });
  if (await terminalSwitch.isVisible()) await terminalSwitch.click();
}

export async function showLab(page: Page): Promise<void> {
  const labSwitch = page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Lab/ });
  if (await labSwitch.isVisible()) await labSwitch.click();
}

export const commandInput = (page: Page): Locator => page.getByRole('textbox', { name: 'Command' });
export const terminalLog = (page: Page): Locator => page.getByRole('log', { name: 'Terminal output' });

/** Types one command at the prompt and presses Enter, then waits for it to be echoed in the log. */
export async function runCommand(page: Page, command: string): Promise<void> {
  const input = commandInput(page);
  await input.fill(command);
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(terminalLog(page)).toContainText(command);
}

/** Fails when the document or the main scroll area is wider than the viewport. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const report: string[] = [];
    const check = (name: string, el: Element | null) => {
      if (el && el.scrollWidth > el.clientWidth + 1) report.push(`${name}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
    };
    check('html', document.documentElement);
    check('body', document.body);
    check('main', document.querySelector('main'));
    return report;
  });
  expect(overflow, 'horizontal overflow').toEqual([]);
}
