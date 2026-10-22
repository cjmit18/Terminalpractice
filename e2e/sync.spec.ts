import { test, expect, headerProgress, runCommand, showTerminal } from './fixtures';
import type { Page, Request } from '@playwright/test';

// Progress sync for a signed-in learner. The preview server has no Worker behind it, so /api/me and
// /api/progress are stubbed here, with a small in-memory server for the progress routes.

const HW_LAB = '#/linux/lpi-101-1-system-architecture';
const LAB = 'lpi-101-1-system-architecture';
const USER = { id: 'u1', name: 'Octo Learner', login: 'octo-learner', avatarUrl: null };

interface Item {
  kind: string;
  key: string;
  scope: string;
  epoch: number;
  earnedAt: number;
  correct?: number;
  total?: number;
}

const done = (n: number) => new RegExp(`^${n} of \\d+ (lab tasks |tasks )?done$`);
const keysWith = (page: Page, prefix: string) =>
  page.evaluate(p => Object.keys(localStorage).filter(k => k.startsWith(p)).sort(), prefix);

test.describe('signed in: progress syncs with the account', () => {
  test.use({ me: { user: USER, providers: { github: true } } });

  test('loads the account progress, uploads a newly finished task, and sign-out clears the account keys', async ({ page, context }) => {
    // The account already has one task of the hardware lab done, from another device
    const server = {
      items: [{ kind: 'objective', key: `${LAB}/hw-lspci`, scope: `lab:${LAB}`, epoch: 0, earnedAt: 1 }] as Item[],
      epochs: {} as Record<string, number>,
      settings: {},
    };
    const puts: unknown[] = [];
    await context.route('**/api/progress', async route => {
      const req = route.request();
      if (req.method() === 'PUT') {
        const body = req.postDataJSON() as { items: Item[] };
        puts.push(body);
        for (const item of body.items) if (!server.items.some(i => i.key === item.key && i.kind === item.kind)) server.items.push(item);
      }
      await route.fulfill({ json: { items: server.items, epochs: server.epochs, settings: server.settings } });
    });

    await page.goto(HW_LAB);
    // The account's progress appears, under the account's own keys; the signed-out keys stay empty
    await expect(headerProgress(page)).toHaveText(done(1));
    await expect.poll(() => keysWith(page, 'certsim:acct:u1:')).toContain('certsim:acct:u1:queue');
    expect(await page.evaluate(() => localStorage.getItem('certsim:progress:v1'))).toBeNull();

    // A task finished here goes up to the account
    const upload = page.waitForRequest((r: Request) => r.url().endsWith('/api/progress') && r.method() === 'PUT');
    await showTerminal(page);
    await runCommand(page, 'lsmod');
    await expect(headerProgress(page)).toHaveText(done(2));
    const sent = (await upload).postDataJSON() as { items: Item[] };
    expect(sent.items).toEqual([expect.objectContaining({ kind: 'objective', key: `${LAB}/hw-lsmod`, epoch: 0 })]);
    await expect.poll(() => server.items.map(i => i.key).sort()).toEqual([`${LAB}/hw-lsmod`, `${LAB}/hw-lspci`]);
    const saved = JSON.parse((await page.evaluate(() => localStorage.getItem('certsim:acct:u1:progress'))) ?? '{}');
    expect(saved[LAB]).toEqual(['hw-lspci', 'hw-lsmod']);

    // Signing out removes the account's data from this browser and shows the signed-out progress
    await page.getByRole('button', { name: 'Account: Octo Learner' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('link', { name: 'Sign in with GitHub' })).toBeVisible();
    await expect.poll(() => keysWith(page, 'certsim:acct:')).toEqual([]);
    await expect(headerProgress(page)).toHaveText(done(0));
    expect(await page.evaluate(() => localStorage.getItem('certsim:account'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('certsim:progress:v1'))).toBeNull();
    expect(puts.length).toBeGreaterThanOrEqual(1);
  });

  test('signed-out progress in this browser is not uploaded on its own', async ({ page, context }) => {
    const seen: Item[] = [];
    await context.route('**/api/progress', async route => {
      const req = route.request();
      if (req.method() === 'PUT') seen.push(...(req.postDataJSON() as { items: Item[] }).items);
      await route.fulfill({ json: { items: [], epochs: {}, settings: {} } });
    });
    // Progress saved before signing in
    await page.addInitScript(lab => {
      if (!localStorage.getItem('certsim:progress:v1')) localStorage.setItem('certsim:progress:v1', JSON.stringify({ [lab]: ['hw-lspci'] }));
    }, LAB);
    await page.goto(HW_LAB);
    await expect.poll(() => keysWith(page, 'certsim:acct:u1:')).toContain('certsim:acct:u1:queue');
    // The account starts from its own (empty) progress
    await expect(headerProgress(page)).toHaveText(done(0));
    await page.waitForTimeout(1500);
    expect(seen.filter(i => i.key.endsWith('hw-lspci'))).toEqual([]);
    // The signed-out record is kept as it was
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('certsim:progress:v1'))) ?? '{}')).toEqual({ [LAB]: ['hw-lspci'] });
  });
});
