import { test, expect } from './fixtures';

test.describe('theme', () => {
  test.use({ colorScheme: 'light' });

  test('choosing Dark sets data-theme on <html> and survives a reload', async ({ page, isMobile }) => {
    await page.goto('#/linux');
    const html = page.locator('html');
    await expect(html).not.toHaveAttribute('data-theme');

    if (isMobile) {
      // Phones get one button that steps System -> Light -> Dark
      await page.getByRole('button', { name: /Switch to light theme/ }).click();
      await page.getByRole('button', { name: /Switch to dark theme/ }).click();
      await expect(page.getByRole('button', { name: /^Dark theme\./ })).toBeVisible();
    } else {
      const dark = page.getByRole('radiogroup', { name: 'Color theme' }).getByRole('radio', { name: 'Dark theme' });
      await dark.click();
      await expect(dark).toHaveAttribute('aria-checked', 'true');
    }
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 19, 23)');

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 19, 23)');
  });
});

test('back button returns from a lab to the catalog', async ({ page }) => {
  await page.goto('#/linux');
  await expect(page.getByRole('heading', { level: 1, name: 'Linux labs' })).toBeVisible();

  await page.getByRole('link', { name: /Manage file permissions and ownership/ }).click();
  await expect(page).toHaveURL(/#\/linux\/lpi-104-5-permissions$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Manage file permissions and ownership' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/#\/linux$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Linux labs' })).toBeVisible();
});

test('main navigation marks the current page', async ({ page }) => {
  await page.goto('#/linux');
  const nav = page.getByRole('navigation', { name: 'Main' }).filter({ visible: true });
  await nav.getByRole('link', { name: /Sandbox/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sandbox' })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Sandbox/ })).toHaveAttribute('aria-current', 'page');
});

test('the home page says the project was built with AI assistance and who maintains it', async ({ page }) => {
  await page.goto('#/learn');
  const about = page.getByRole('region', { name: 'About this project' });
  await expect(about).toContainText('built with AI assistance');
  await expect(about).toContainText('I maintain and develop it myself');
  await expect(about).toContainText('Not affiliated with or endorsed by');
  await expect(about.getByRole('link', { name: 'github.com/cjmit18/Terminalpractice' })).toHaveAttribute('href', 'https://github.com/cjmit18/Terminalpractice');
});
