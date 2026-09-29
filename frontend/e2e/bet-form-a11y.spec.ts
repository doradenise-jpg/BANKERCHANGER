import { test, expect, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TEST_PUBLIC_KEY = 'GABC1234WXYZ5678GABC1234WXYZ5678GABC1234WXYZ5678GABC1234WXYZ';

const OPEN_MARKET = {
  market_id: 'mkt-a11y-1',
  match_id: 'match-a11y-1',
  fighter_a: 'Fighter Alpha',
  fighter_b: 'Fighter Beta',
  weight_class: 'Lightweight',
  title_fight: false,
  venue: 'Test Arena',
  scheduled_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  status: 'open',
  outcome: null,
  pool_a: '100000000',
  pool_b: '100000000',
  pool_draw: '50000000',
  total_pool: '250000000',
  odds_a: 5000,
  odds_b: 5000,
  odds_draw: 2500,
  fee_bps: 200,
  contract_address: 'CTEST_MARKET_CONTRACT',
  factory_address: 'CFACTORY_CONTRACT',
};

async function mockBackend(page: Page) {
  await page.route('**/api/markets*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes(`/api/markets/${OPEN_MARKET.market_id}`)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(OPEN_MARKET),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ markets: [OPEN_MARKET], total: 1, page: 1, limit: 20 }),
    });
  });

  await page.route(`**/api/markets/${OPEN_MARKET.market_id}/bets`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    }),
  );
}

async function injectWallet(page: Page) {
  await page.addInitScript((pubKey) => {
    (window as any).freighter = {
      isConnected: () => Promise.resolve(true),
      getPublicKey: () => Promise.resolve(pubKey),
      signTransaction: (_xdr: string) => Promise.resolve('SIGNED_XDR'),
      getNetwork: () => Promise.resolve('TESTNET'),
      getNetworkDetails: () =>
        Promise.resolve({
          network: 'TESTNET',
          networkPassphrase: 'Test SDF Network ; September 2015',
          networkUrl: 'https://soroban-testnet.stellar.org',
        }),
    };
  }, TEST_PUBLIC_KEY);
}

async function openBetForm(page: Page) {
  await mockBackend(page);
  await injectWallet(page);
  await page.goto(`/markets/${OPEN_MARKET.market_id}`);
  await page.getByRole('button', { name: /connect wallet/i }).first().click();
  await expect(page.getByText(/GABC.*WXYZ/i)).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('button', { name: /^place bet$/i })).toBeVisible();
}

test.describe('Bet form accessibility', () => {
  test('should have no critical or serious axe violations', async ({ page }) => {
    await openBetForm(page);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const criticalViolations = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );

    if (criticalViolations.length > 0) {
      console.error(
        'A11y violations on bet form:',
        JSON.stringify(criticalViolations, null, 2),
      );
    }

    expect(criticalViolations).toHaveLength(0);
  });

  test('amount input has a programmatically associated label', async ({ page }) => {
    await openBetForm(page);

    // getByLabel only matches when a <label> is linked via htmlFor/id
    // or wraps the input directly.
    const amountInput = page.getByLabel(/amount \(xlm\)/i);
    await expect(amountInput).toBeVisible();
    await expect(amountInput).toHaveAttribute('type', 'number');
    await expect(amountInput).toHaveAttribute('min', '1');
  });

  test('outcome selector exposes a named group with toggle buttons', async ({ page }) => {
    await openBetForm(page);

    const group = page.getByRole('group', { name: /choose your outcome/i });
    await expect(group).toBeVisible();

    // Each outcome button reports its pressed state for assistive tech.
    const fighterButton = group.getByRole('button', { name: /fighter alpha/i });
    await expect(fighterButton).toHaveAttribute('aria-pressed', 'false');
    await fighterButton.click();
    await expect(fighterButton).toHaveAttribute('aria-pressed', 'true');
  });
});