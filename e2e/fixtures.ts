import { test as base, expect, type Locator, type Page } from '@playwright/test';
import type { QuizQuestion } from '../src/types/paths';

/**
 * Shared test setup: every test fails if the page logs a console error or throws,
 * unless it opts out with `test.use({ allowConsoleErrors: true })`.
 */
/** What the stubbed account API answers for /api/me (the preview server has no Worker behind it). */
export type MeResponse = {
  user: { id: string; name: string; login: string | null; avatarUrl: string | null; email?: string | null; emailVerified?: boolean } | null;
  providers: { github: boolean; email?: boolean };
  emailSending?: boolean;
};

export const test = base.extend<{ allowConsoleErrors: boolean; consoleErrors: string[]; me: MeResponse; accountApi: void }>({
  allowConsoleErrors: [false, { option: true }],
  // Default: no account API configured, so the app shows no sign-in control, as on a fresh deploy
  me: [{ user: null, providers: { github: false } }, { option: true }],
  accountApi: [
    async ({ context, me }, use) => {
      await context.route('**/api/me', route => route.fulfill({ json: me }));
      await context.route('**/api/logout', route => route.fulfill({ json: { ok: true } }));
      // Signed in, the app syncs progress; an account with none yet, unless a test routes it itself
      await context.route('**/api/progress', route => route.fulfill({ json: { items: [], epochs: {}, settings: {} } }));
      await use();
    },
    { auto: true },
  ],
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
  page.getByRole('banner').getByText(/^\d+ of \d+ (lab tasks |tasks )?done$/);

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

/**
 * Takes a checkpoint to the end. Its questions come in a new random order on every attempt, so each
 * one is found by the prompt on screen; `right(q, i)` says whether to answer the i-th shown question
 * right. Returns the questions in the order they were shown.
 */
export async function takeCheckpoint(
  page: Page,
  questions: readonly QuizQuestion[],
  right: (q: QuizQuestion, i: number) => boolean,
): Promise<QuizQuestion[]> {
  const shown: QuizQuestion[] = [];
  for (let i = 0; i < questions.length; i++) {
    const legend = page.getByRole('main').locator('fieldset legend span[tabindex="-1"]');
    const prompt = (await legend.textContent())?.trim() ?? '';
    const q = questions.find(x => x.prompt === prompt);
    if (!q) throw new Error(`question not in this checkpoint: ${prompt}`);
    const choice = right(q, i) ? q.answer : (q.answer + 1) % q.choices.length;
    // Scoped to the question: the header has its own theme radios
    await page.getByRole('main').getByRole('group', { name: q.prompt }).getByRole('radio').nth(choice).check();
    await page.getByRole('button', { name: 'Check answer' }).click();
    await page.getByRole('button', { name: i < questions.length - 1 ? 'Next question' : 'See your score' }).click();
    shown.push(q);
  }
  return shown;
}
