import { renderHook, act, waitFor } from '@testing-library/react';
import { useClaimWinnings } from '../useClaimWinnings';
import * as api from '../../services/api';
import * as wallet from '../../services/wallet';

jest.mock('../../services/api');
jest.mock('../../services/wallet');

const marketId = 'm1';
const address = 'GABC123';

beforeEach(() => {
  jest.clearAllMocks();
  (wallet.submitClaimWithStages as jest.Mock).mockResolvedValue('tx-hash');
});

test('AC #2 — does not submit when the bet is already claimed', async () => {
  (api.fetchBetsByMarket as jest.Mock).mockResolvedValue([
    { market_id: marketId, address, claimed: true, payout: 100 },
  ]);

  const { result } = renderHook(() => useClaimWinnings(address));

  await act(async () => {
    await result.current.claimWinnings(marketId);
  });

  expect(wallet.submitClaimWithStages).not.toHaveBeenCalled();
  expect(result.current.hasClaimed).toBe(true);
});

test('AC #1 — a second click during submit is a no-op', async () => {
  (api.fetchBetsByMarket as jest.Mock).mockResolvedValue([
    { market_id: marketId, address, claimed: false },
  ]);

  let resolveSubmit: (hash: string) => void = () => {};
  (wallet.submitClaimWithStages as jest.Mock).mockImplementation(
    () => new Promise<string>((res) => (resolveSubmit = res)),
  );

  const { result } = renderHook(() => useClaimWinnings(address));

  // Fire two claims back-to-back in the same tick — the race the issue describes.
  await act(async () => {
    const p1 = result.current.claimWinnings(marketId);
    const p2 = result.current.claimWinnings(marketId);
    resolveSubmit('tx-hash');
    await Promise.all([p1, p2]);
  });

  expect(wallet.submitClaimWithStages).toHaveBeenCalledTimes(1);
});

test('submit proceeds for an unclaimed bet', async () => {
  (api.fetchBetsByMarket as jest.Mock).mockResolvedValue([
    { market_id: marketId, address, claimed: false },
  ]);

  const { result } = renderHook(() => useClaimWinnings(address));

  await act(async () => {
    await result.current.claimWinnings(marketId);
  });

  expect(wallet.submitClaimWithStages).toHaveBeenCalledWith(
    marketId,
    expect.any(Function),
  );
  await waitFor(() => expect(result.current.hasClaimed).toBe(true));
});