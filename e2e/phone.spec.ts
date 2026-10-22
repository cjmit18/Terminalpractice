import { test, expect, commandInput, runCommand } from './fixtures';

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout only');

  test('the page never scrolls past the tab bar, even when something sticks out below the frame', async ({ page }) => {
    await page.goto('#/learn');
    const nav = page.getByRole('navigation', { name: 'Main' }).last();
    await expect(nav).toBeVisible();
    // Something taller than the screen hanging below the app frame, as a stray element might
    await page.evaluate(() => {
      const extra = document.createElement('div');
      extra.style.cssText = 'position:absolute;top:100%;left:0;width:10px;height:1500px';
      document.body.appendChild(extra);
      window.scrollTo(0, 99999);
    });
    // The learning content still scrolls inside the frame
    await page.locator('main').evaluate(m => (m.scrollTop = m.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const box = await nav.boundingBox();
    const height = page.viewportSize()!.height;
    expect(box && Math.round(box.y + box.height)).toBe(height);
    expect(await page.locator('main').evaluate(m => m.scrollTop)).toBeGreaterThan(0);
  });

  test('the Lab/Terminal switch shows one pane at a time', async ({ page }) => {
    await page.goto('#/linux/lpi-104-5-permissions');
    const show = page.getByRole('group', { name: 'Show' });
    const labButton = show.getByRole('button', { name: /^Lab/ });
    const terminalButton = show.getByRole('button', { name: 'Terminal' });

    await expect(labButton).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('heading', { name: 'Your tasks' })).toBeVisible();
    await expect(commandInput(page)).toBeHidden();

    await terminalButton.tap();
    await expect(terminalButton).toHaveAttribute('aria-pressed', 'true');
    await expect(commandInput(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your tasks' })).toBeHidden();

    await runCommand(page, 'umask 027');
    await labButton.tap();
    await expect(labButton).toContainText('1 of 4');
  });

  test('the key toolbar Ctrl+C clears a typed line', async ({ page }) => {
    await page.goto('#/linux/lpi-104-5-permissions');
    await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Terminal' }).tap();

    const input = commandInput(page);
    await input.tap();
    await input.pressSequentially('ls -la /etc');
    await expect(input).toHaveValue('ls -la /etc');

    const keys = page.getByRole('toolbar', { name: 'Terminal keys' });
    await expect(keys).toBeVisible();
    await keys.getByRole('button', { name: 'Insert |' }).tap();
    await expect(input).toHaveValue('ls -la /etc|');

    await keys.getByRole('button', { name: 'Control C, cancel line' }).tap();
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
  });
});
