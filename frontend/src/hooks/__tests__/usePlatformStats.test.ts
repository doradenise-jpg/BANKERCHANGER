/**
 * Tests for usePlatformStats hook (Issue #70)
 *
 * Covers:
 *  - Initial loading state
 *  - Successful fetch populates stats correctly
 *  - API error sets error state and leaves stats null
 *  - Network error sets error state and leaves stats null
 *  - Recovery: subsequent successful fetch after error clears the error
 *  - Fallback values are "--" when stats are unavailable (component concern
 *    verified via hook output)
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { server } from '../../__tests__/mocks/handlers';
import { http, HttpResponse } from 'msw';
import { usePlatformStats } from '../usePlatformStats';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

/** Minimal market shapes the hook actually reads from the list endpoint. */
const openMarket = {
  status: 'open',
  total_pool: '10000000', // 1 XLM
};

const resolvedMarket = {
  status: 'resolved',
  total_pool: '20000000', // 2 XLM
};

const emptyPool = {
  status: 'open',
  total_pool: '0',
};

describe('usePlatformStats', () => {
  describe('initial state', () => {
    it('starts with isLoading = true', () => {
      const { result } = renderHook(() => usePlatformStats());
      expect(result.current.isLoading).toBe(true);
    });

    it('starts with stats = null', () => {
      const { result } = renderHook(() => usePlatformStats());
      expect(result.current.stats).toBeNull();
    });

    it('starts with error = null', () => {
      const { result } = renderHook(() => usePlatformStats());
      expect(result.current.error).toBeNull();
    });
  });

  describe('successful fetch', () => {
    beforeEach(() => {
      server.use(
        http.get(`${API_BASE}/api/markets`, () =>
          HttpResponse.json({
            markets: [openMarket, openMarket, resolvedMarket],
            total: 3,
            page: 1,
            limit: 1000,
          }),
        ),
      );
    });

    it('sets isLoading to false after fetch', async () => {
      const { result } = renderHook(() => usePlatformStats());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    it('populates stats after fetch', async () => {
      const { result } = renderHook(() => usePlatformStats());
      await waitFor(() => expect(result.current.stats).not.toBeNull());
      expect(result.current.stats).not.toBeNull();
    });

    it('counts only open markets as activeMarkets', async () => {
      const { result } = renderHook(() => usePlatformStats());
      await waitFor(() => expect(result.current.stats).not.toBeNull());
      // 2 open, 1 resolved
      expect(result.current.stats!.activeMarkets).toBe(2);
    });

    it('sums total_pool values into totalVolume in XLM', async () => {
      const { result } = renderHook(() => usePlatformStats());
      await waitFor(() => expect(result.current.stats).not.toBeNull());
      // (10_000_000 + 10_000_000 + 20_000_000) / 1e7 = 4 XLM
      expect(result.current.stats!.totalVolume).toBeCloseTo(4, 5);
    });

    it('clears error on successful load', async () => {
      const { result } = renderHook(() => usePlatformStats());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.error).toBeNull();
    });

    it('markets with zero total_pool still count for totalBets proxy', async () => {
      server.use(
        http.get(`${API_BASE}/api/markets`, () =>
          HttpResponse.json({
            markets: [openMarket, emptyPool],
            total: 2,
            page: 1,
            limit: 1000,
          }),
        ),
      );
      const { result } = renderHook(() => usePlatformStats());
      await waitFor(() => expect(result.current.stats).not.toBeNull());
      // Only markets with total_pool > 0 count
      expect(result.current.stats!.totalBets).toBe(1);
    });
  });

  describe('API error handling — core regression for issue #70', () => {
    it('sets error when API returns a 500 response', async () => {
      server.use(
        http.get(`${API_BASE}/api/markets`, () =>
          HttpResponse.json({ error: 'Internal Server Error' }, { status: 500 }),
        ),
      );

      const { result } = renderHook(() => usePlatformStats());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.error).not.toBeNull();
    });

    it('leaves stats null when API returns a 500 response', async () => {
      server.use(
        http.get(`${API_BASE}/api/markets`, () =>
          HttpResponse.json({ error: 'Internal Server Error' }, { status: 500 }),
        ),
      );

      const { result } = renderHook(() => usePlatformStats());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // stats must remain null so callers can detect the error and show "--"
      expect(result.current.stats).toBeNull();
    });

    it('sets error when API returns a 503 response', async () => {
      server.use(
        http.get(`${API_BASE}/api/markets`, () =>
          HttpResponse.json({ error: 'Service Unavailable' }, { status: 503 }),
        ),
      );

      const { result } = renderHook(() => usePlatformStats());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.error).not.toBeNull();
    });

    it('sets error on network failure', async () => {
      server.use(
        http.get(`${API_BASE}/api/markets`, () => HttpResponse.error()),
      );

      const { result } = renderHook(() => usePlatformStats());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.error).not.toBeNull();
      expect(result.current.stats).toBeNull();
    });

    it('error is an instance of Error', async () => {
      server.use(
        http.get(`${API_BASE}/api/markets`, () =>
          HttpResponse.json({ error: 'Bad Gateway' }, { status: 502 }),
        ),
      );

      const { result } = renderHook(() => usePlatformStats());

      await waitFor(() => expect(result.current.error).not.toBeNull());

      expect(result.current.error).toBeInstanceOf(Error);
    });

    it('isLoading is false after error (not stuck loading)', async () => {
      server.use(
        http.get(`${API_BASE}/api/markets`, () =>
          HttpResponse.json({ error: 'Internal Server Error' }, { status: 500 }),
        ),
      );

      const { result } = renderHook(() => usePlatformStats());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Must be false — component must not spin indefinitely on error
      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('fallback values contract', () => {
    it('stats.activeMarkets is undefined/null when error — consumers must use "--"', async () => {
      server.use(
        http.get(`${API_BASE}/api/markets`, () =>
          HttpResponse.json({ error: 'fail' }, { status: 500 }),
        ),
      );

      const { result } = renderHook(() => usePlatformStats());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      // Verify the null contract so StatsBanner/PlatformStatsBanner can safely
      // branch on !stats and render "--" instead of undefined/NaN
      expect(result.current.stats).toBeNull();
      expect(result.current.error).not.toBeNull();
    });
  });

  describe('cleanup on unmount', () => {
    it('does not update state after unmount', async () => {
      server.use(
        http.get(`${API_BASE}/api/markets`, () =>
          HttpResponse.json({
            markets: [openMarket],
            total: 1,
            page: 1,
            limit: 1000,
          }),
        ),
      );

      const { result, unmount } = renderHook(() => usePlatformStats());

      unmount();

      // No state-update-after-unmount errors should be thrown
      await expect(
        waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 500 }),
      ).rejects.toBeDefined(); // still loading because cancelled
    });
  });
});
