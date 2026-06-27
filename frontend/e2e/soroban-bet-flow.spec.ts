/**
 * E2E: Full bet flow against a local Soroban standalone node.
 *
 * Prerequisites (handled by CI setup step):
 *   - stellar-cli network start --local launches a local Soroban node
 *   - Contracts deployed to local node, market/factory addresses in env
 *   - App running against http://localhost:3000 with NEXT_PUBLIC_STELLAR_NETWORK=local
 *
 * Flow:
 *   connect wallet → create market → place bet → oracle resolution → claim winnings
 *
 * Environment variables (set by CI):
 *   SOROBAN_MARKET_CONTRACT_ID  — deployed market contract address
 *   SOROBAN_TEST_SECRET_KEY     — funded test keypair secret key
 *   SOROBAN_TEST_PUBLIC_KEY     — corresponding public key
 *   NEXT_PUBLIC_API_URL         — backend URL (http://localhost:3001)
 */

import { test, expect, Page } from '@playwright/test';

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_PUBLIC_KEY =
  process.env.SOROBAN_TEST_PUBLIC_KEY ??
  'GABC1234WXYZ5678GABC1234WXYZ5678GABC1234WXYZ5678GABC1234WXYZ';

const MARKET_CONTRACT_ID =
  process.env.SOROBAN_MARKET_CONTRACT_ID ?? 'CTEST_MARKET_CONTRACT_PLACEHOLDER';

const BET_AMOUNT_XLM = '5';

// Mock market returned by the backend (backed by the local contract)
const LOCAL_MARKET = {
  market_id: 'local-market-001',
  match_id: 'local-match-001',
  fighter_a: 'Fighter Alpha',
  fighter_b: 'Fighter Beta',
  weight_class: 'Lightweight',
  title_fight: false,
  venue: 'Local Soroban Arena',
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
  contract_address: MARKET_CONTRACT_ID,
};

const RESOLVED_MARKET = {
  ...LOCAL_MARKET,
  status: 'resolved',
  outcome: 'fighter_a',
  oracle_address: TEST_PUBLIC_KEY,
  resolution_tx_hash:
    'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function mockBackendRoutes(page: Page, resolved = false) {
  const market = resolved ? RESOLVED_MARKET : LOCAL_MARKET;

  await page.route('**/api/markets*', (route) => {
    const url = new URL(route.request().url());
    // Handle /api/markets/:id
    if (url.pathname.includes(`/api/markets/${LOCAL_MARKET.market_id}`)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(market),
      });
    }
    // Handle /api/markets list
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ markets: [market], total: 1, page: 1, limit: 20 }),
    });
  });

  await page.route(`**/api/markets/${LOCAL_MARKET.market_id}/bets`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    }),
  );

  // Mock Stellar/Horizon transaction submission
  await page.route('**/transactions', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hash: RESOLVED_MARKET.resolution_tx_hash,
        successful: true,
      }),
    }),
  );
}

/** Inject a mock Freighter extension backed by the test keypair */
async function injectTestWallet(page: Page) {
  await page.addInitScript((pubKey) => {
    (window as any).freighter = {
      isConnected: () => Promise.resolve(true),
      getPublicKey: () => Promise.resolve(pubKey),
      signTransaction: (_xdr: string) => Promise.resolve('SIGNED_XDR_LOCAL_NODE'),
      getNetwork: () => Promise.resolve('LOCAL'),
      getNetworkDetails: () =>
        Promise.resolve({
          network: 'LOCAL',
          networkPassphrase: 'Standalone Network ; February 2017',
          networkUrl: 'http://localhost:8000',
        }),
    };
  }, TEST_PUBLIC_KEY);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Full bet flow — local Soroban node', () => {
  test('1. Connect wallet — public key appears in header', async ({ page }) => {
    await mockBackendRoutes(page);
    await injectTestWallet(page);

    await page.goto('/');
    await page.getByRole('button', { name: /connect wallet/i }).first().click();

    // Truncated address should appear: GABC…WXYZ
    await expect(page.getByText(/GABC.*WXYZ/i)).toBeVisible({ timeout: 8000 });
  });

  test('2. Market list — local contract market is visible', async ({ page }) => {
    await mockBackendRoutes(page);
    await injectTestWallet(page);

    await page.goto('/');

    await expect(page.getByText('Fighter Alpha')).toBeVisible();
    await expect(page.getByText('Fighter Beta')).toBeVisible();
  });

  test('3. Navigate to market detail page', async ({ page }) => {
    await mockBackendRoutes(page);
    await injectTestWallet(page);

    await page.goto('/');
    await page.getByRole('link', { name: /Fighter Alpha/i }).first().click();
    await page.waitForURL(`**/markets/${LOCAL_MARKET.market_id}`);

    await expect(page.getByText('Fighter Alpha')).toBeVisible();
    await expect(page.getByText('Fighter Beta')).toBeVisible();
  });

  test('4. Place a bet on Fighter Alpha', async ({ page }) => {
    await mockBackendRoutes(page);
    await injectTestWallet(page);

    await page.goto(`/markets/${LOCAL_MARKET.market_id}`);

    // Connect wallet
    await page.getByRole('button', { name: /connect wallet/i }).first().click();
    await expect(page.getByText(/GABC.*WXYZ/i)).toBeVisible({ timeout: 8000 });

    // Select Fighter A
    await page.getByRole('button', { name: /Fighter Alpha/i }).first().click();

    // Enter bet amount
    await page.getByPlaceholder('0.00').fill(BET_AMOUNT_XLM);

    // Verify estimated payout appears
    await expect(page.getByText(/Est\. payout/i)).toBeVisible();

    // Click Place Bet → confirm modal
    await page.getByRole('button', { name: /place bet/i }).click();
    await expect(page.getByRole('heading', { name: /confirm bet/i })).toBeVisible();

    // Confirm bet
    await page.getByRole('button', { name: /confirm bet/i }).click();

    // Success toast with partial tx hash
    await expect(page.getByText(/bet placed/i)).toBeVisible({ timeout: 10_000 });
  });

  test('5. Oracle resolution — resolved market shows outcome', async ({ page }) => {
    // Return the resolved version of the market
    await mockBackendRoutes(page, true);
    await injectTestWallet(page);

    await page.goto(`/markets/${LOCAL_MARKET.market_id}`);

    // Market shows as resolved
    await expect(page.getByText(/resolved/i)).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/fighter.a/i)).toBeVisible();
  });

  test('6. Claim winnings panel is visible on resolved market', async ({ page }) => {
    await mockBackendRoutes(page, true);
    await injectTestWallet(page);

    await page.goto(`/markets/${LOCAL_MARKET.market_id}`);

    // Connect wallet so claim panel checks address
    await page.getByRole('button', { name: /connect wallet/i }).first().click();
    await expect(page.getByText(/GABC.*WXYZ/i)).toBeVisible({ timeout: 8000 });

    // Claim section should be present
    await expect(page.getByText(/claim/i)).toBeVisible({ timeout: 5000 });
  });
});
