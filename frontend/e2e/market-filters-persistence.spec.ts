import { test, expect, Page } from '@playwright/test';

async function mockMarkets(page: Page) {
  await page.route('**/api/markets*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        markets: [
          {
            market_id: 'm1',
            match_id: 'x',
            fighter_a: 'Fighter A',
            fighter_b: 'Fighter B',
            weight_class: 'Heavyweight',
            status: 'open',
            scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
            pool_a: '0', pool_b: '0', pool_draw: '0', total_pool: '0',
            odds_a: 5000, odds_b: 5000, odds_draw: 0, fee_bps: 200,
            contract_address: 'C...', factory_address: 'C...',
            title_fight: false, venue: 'Arena', outcome: null,
          },
        ],
        total: 1, page: 1, limit: 20,
      }),
    }),
  );
}

test.describe('Market filter persistence (#713)', () => {
  test('weight class filter writes weight_class= to URL and survives reload', async ({ page }) => {
    await mockMarkets(page);
    await page.goto('/');

    await page.getByLabel(/filter by weight class/i).selectOption('Heavyweight');
    await expect(page).toHaveURL(/weight_class=Heavyweight/);

    await page.reload();
    await expect(page.getByLabel(/filter by weight class/i)).toHaveValue('Heavyweight');
  });

  test('sort writes backend vocabulary (date_asc) not frontend labels', async ({ page }) => {
    await mockMarkets(page);
    await page.goto('/');

    await page.getByLabel(/sort markets/i).selectOption('date_asc');
    await expect(page).toHaveURL(/sort=date_asc/);
  });

  test('status filter is shareable via URL', async ({ page }) => {
    await mockMarkets(page);
    await page.goto('/?status=open');

    const openTab = page.getByRole('tab', { name: /filter by open status/i });
    await expect(openTab).toHaveAttribute('aria-selected', 'true');
  });
});