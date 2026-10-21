import { test, expect, expectNoHorizontalOverflow } from './fixtures';
import { LEARNING_PATHS } from '../src/data/paths';

const firstPath = LEARNING_PATHS[0];
const firstLesson = firstPath.stages.flatMap(s => s.steps).find(s => s.kind === 'lesson');

/** Every page, by hash route, with the level-1 heading it should show. */
const ROUTES: { path: string; heading: string }[] = [
  { path: '', heading: 'Learning paths' },
  { path: '#/learn', heading: 'Learning paths' },
  { path: `#/learn/${firstPath.id}`, heading: firstPath.title },
  ...(firstLesson && firstLesson.kind === 'lesson' ? [{ path: `#/learn/${firstPath.id}/${firstLesson.id}`, heading: firstLesson.title }] : []),
  { path: '#/linux', heading: 'Linux labs' },
  { path: '#/windows', heading: 'Windows labs' },
  { path: '#/linux/lpi-104-5-permissions', heading: 'Manage file permissions and ownership' },
  { path: '#/windows/win-pbq-active-directory-mgmt', heading: 'Unlock an account and add a domain admin' },
  { path: '#/simulators', heading: 'Simulators' },
  { path: '#/sandbox', heading: 'Sandbox' },
  { path: '#/reference', heading: 'Command reference' },
];

const BACKGROUNDS = { light: 'rgb(246, 246, 243)', dark: 'rgb(17, 19, 23)' } as const;

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} scheme`, () => {
    test.use({ colorScheme });

    for (const { path, heading } of ROUTES) {
      test(`${path || 'home'} renders without errors or horizontal overflow`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        // The page follows the OS theme when the user has not picked one
        await expect(page.locator('body')).toHaveCSS('background-color', BACKGROUNDS[colorScheme]);
        await expectNoHorizontalOverflow(page);
      });
    }
  });
}

test('an unknown lab id falls back to the catalog', async ({ page }) => {
  await page.goto('#/linux/no-such-lab');
  await expect(page).toHaveURL(/#\/linux$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Linux labs' })).toBeVisible();
});
