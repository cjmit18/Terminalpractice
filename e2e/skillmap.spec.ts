import { test, expect } from './fixtures';

const row = (page: import('@playwright/test').Page, id: string) => page.locator(`[data-objective="${id}"]`);

test('path overview lists exam objectives with honest states and official links', async ({ page }) => {
  await page.goto('#/learn/lpic1-101');
  const map = page.getByTestId('skill-map');
  await expect(map.getByRole('heading', { name: 'Exam objectives' })).toBeVisible();
  await expect(page.getByTestId('readiness')).toHaveText('You have practised 0 of 12 objectives this path covers. No checkpoints taken yet.');
  await expect(row(page, '104.5')).toContainText('Not started');
  await expect(row(page, '103.7')).toContainText('Not covered here: study elsewhere');
  await expect(row(page, '103.7').locator('.text-danger')).toHaveCount(0);
  await expect(map.getByRole('link', { name: 'LPIC-1 exam objectives on lpi.org' })).toHaveAttribute(
    'href',
    'https://www.lpi.org/our-certifications/exam-101-102-objectives/',
  );
  await expect(map).not.toContainText(/likely to pass|chance of passing/i);
});

test('reading a lesson and passing a checkpoint move objectives on', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'certsim:journey:v1',
      JSON.stringify({
        read: ['lpic1-101/how-linux-sees-hardware'],
        quiz: { 'lpic1-101/quiz-hardware': { correct: 4, total: 5 } },
        last: null,
      }),
    );
  });
  await page.goto('#/learn/lpic1-101');
  // 101.1 also has a question in the final check, which is not taken yet
  await expect(row(page, '101.1')).toHaveAttribute('data-state', 'practised');
  await expect(row(page, '101.2')).toHaveAttribute('data-state', 'confident');
  await expect(row(page, '101.2')).toContainText('Confident');
  await expect(page.getByTestId('readiness')).toHaveText('You have practised 3 of 12 objectives this path covers. Checkpoint average 80%.');
});

test('the Network+ and Security+ path shows both exams by domain', async ({ page }) => {
  await page.goto('#/learn/netsec-windows');
  await expect(page.getByRole('heading', { name: /CompTIA Network\+ \(N10-009\)/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /CompTIA Security\+ \(SY0-701\)/ })).toBeVisible();
  await expect(row(page, 'sy0-701:3.0')).toContainText('Not covered here: study elsewhere');
});
