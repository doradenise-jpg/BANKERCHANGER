import { afterAll, test, expect, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { cleanupE2eData } from './cleanup';

afterAll(cleanupE2eData);

async function mockMarketsApi(page: Page, markets = [
  {
    market_id: 'e2e_test_mkt-filter-1',
    match_id: 'e2e_test_match-filter-1',
    fighter_a: 'Fighter A',
    fighter_b: 'Fighter B',
    weight_class: 'Heavyweight',
    status: 'open',
    scheduled_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
  },
]) {
  await page.route('**/api/markets*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ markets, total: markets.length, page: 1, limit: 20 }),
    });
  });
}

test.describe('MarketFilters accessibility', () => {
  test('should have no critical or serious axe violations', async ({ page }) => {
    await mockMarketsApi(page);
    await page.goto('/');
    await expect(page.getByText('Fighter A')).toBeVisible();

    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
    const criticalViolations = accessibilityScanResults.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );

    expect(criticalViolations).toHaveLength(0);
    if (criticalViolations.length > 0) {
      console.error('Accessibility violations found:', criticalViolations);
    }
  });

  test('should support keyboard navigation through status tabs', async ({ page }) => {
    await mockMarketsApi(page);
    await page.goto('/');
    await expect(page.getByText('Fighter A')).toBeVisible();

    const tabList = page.getByRole('tablist', { name: /filter by market status/i });
    await expect(tabList).toBeVisible();

    const tabs = tabList.getByRole('tab');
    await expect(tabs).toHaveCount(4);

    await tabs.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(1)).toBeFocused();

    await page.keyboard.press('ArrowLeft');
    await expect(tabs.nth(0)).toBeFocused();

    await page.keyboard.press('End');
    await expect(tabs.nth(3)).toBeFocused();

    await page.keyboard.press('Home');
    await expect(tabs.nth(0)).toBeFocused();

    await tabs.nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/status=open/);
  });
});
