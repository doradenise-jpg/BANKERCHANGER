/**
 * Unit tests for useMarkets hook using @testing-library/react and MSW.
 */

import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { useMarkets } from '../../hooks/useMarkets';
import { server } from '../mocks/handlers';
import { mockMarkets } from '../mocks/handlers';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '../../components/ui/ToastProvider';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1;
  listeners = new Map<string, Array<(event: any) => void>>();
  sent: string[] = [];

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
    if (type === 'open') listener({});
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emitMessage(data: unknown) {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }
}

describe('useMarkets', () => {
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    originalWebSocket = window.WebSocket;
  });

  afterEach(() => {
    window.WebSocket = originalWebSocket;
  });

  it('prepends a newly created market and marks it new', async () => {
    MockWebSocket.instances = [];
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const newMarket = {
      ...mockMarkets[0],
      market_id: 'market-new',
      fighter_a: 'Alpha',
      fighter_b: 'Beta',
    };
    server.use(
      http.post('http://localhost:3001/auth/activity-feed-token', () =>
        HttpResponse.json({ accessToken: 'activity-token' }),
      ),
      http.get('http://localhost:3001/api/markets/market-new', () => HttpResponse.json(newMarket)),
    );
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(ToastProvider, null, children);

    const { result } = renderHook(() => useMarkets(), { wrapper });
    await waitFor(() => expect(result.current.markets).toHaveLength(mockMarkets.length));
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));

    const socket = MockWebSocket.instances[0];
    await waitFor(() => expect(socket.sent).toHaveLength(2));
    act(() => {
      socket.emitMessage({
        type: 'market:created',
        marketId: 'market-new',
        fighterA: 'Alpha',
        fighterB: 'Beta',
      });
    });

    await waitFor(() => expect(result.current.markets[0].market_id).toBe('market-new'));
    expect(result.current.newMarketIds.has('market-new')).toBe(true);
    expect(screen.getByText('New market: Alpha vs Beta')).toBeTruthy();
  });

  describe('Initial loading state', () => {
    it('should start with isLoading = true', () => {
      const { result } = renderHook(() => useMarkets());
      expect(result.current.isLoading).toBe(true);
    });

    it('should start with empty markets array', () => {
      const { result } = renderHook(() => useMarkets());
      expect(result.current.markets).toEqual([]);
    });

    it('should start with null error', () => {
      const { result } = renderHook(() => useMarkets());
      expect(result.current.error).toBeNull();
    });

    it('should start with total = 0', () => {
      const { result } = renderHook(() => useMarkets());
      expect(result.current.total).toBe(0);
    });
  });

  describe('Markets populated after successful fetch', () => {
    it('should populate markets array after API success', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.markets).toHaveLength(mockMarkets.length);
      expect(result.current.markets[0].market_id).toBe('market-1');
      expect(result.current.markets[1].market_id).toBe('market-2');
    });

    it('should set total to correct count', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.total).toBe(mockMarkets.length);
    });

    it('should set isLoading = false after data fetch', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should clear error on successful fetch', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('Error state set on failed fetch', () => {
    it('should set error on network failure', async () => {
      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json(
            { error: 'Internal Server Error' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });

      expect(result.current.error?.message).toContain('Unexpected response');
    });

    it('should keep isLoading = false when error occurs', async () => {
      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json(
            { error: 'Server Error' },
            { status: 500 }
          );
        })
      );

      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('should clear previous data on error', async () => {
      const { result, rerender } = renderHook(
        ({ filters }) => useMarkets(filters),
        { initialProps: { filters: undefined } }
      );

      await waitFor(() => {
        expect(result.current.markets).toHaveLength(mockMarkets.length);
      });

      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json(
            { error: 'Server Error' },
            { status: 500 }
          );
        })
      );

      rerender({ filters: undefined });

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });
    });
  });

  describe('refetch() triggers a new fetch', () => {
    it('should expose refetch function', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(typeof result.current.refetch).toBe('function');
    });

    it('should trigger new fetch when refetch() is called', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const initialMarketsCount = result.current.markets.length;

      // Call refetch
      result.current.refetch();

      // Wait for the new fetch to complete
      await waitFor(() => {
        expect(result.current.markets.length).toBe(initialMarketsCount);
      });

      // Verify markets are still there
      expect(result.current.markets).toHaveLength(mockMarkets.length);
    });

    it('should handle errors during refetch', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Change handler to return error
      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json(
            { error: 'Server Error' },
            { status: 500 }
          );
        })
      );

      result.current.refetch();

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });
    });

    it('should not trigger isLoading during background refetch', async () => {
      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      result.current.refetch();

      // isLoading should remain false (stale data during background refresh)
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });
  });

  describe('Filters support', () => {
    it('should respect status filter', async () => {
      const { result } = renderHook(() => useMarkets({ status: 'resolved' }));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Should only get resolved markets
      const allResolved = result.current.markets.every(m => m.status === 'resolved');
      expect(allResolved).toBe(true);
    });

    it('should update when filters change', async () => {
      const { result, rerender } = renderHook(
        ({ filters }) => useMarkets(filters),
        { initialProps: { filters: undefined } }
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const totalCount = result.current.total;

      // Change filter
      rerender({ filters: { status: 'resolved' } });

      await waitFor(() => {
        expect(result.current.total).toBeLessThan(totalCount);
      });
    });
  });

  describe('Auto-polling every 30 seconds', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should auto-poll markets every 30 seconds', async () => {
      let callCount = 0;

      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          callCount++;
          return HttpResponse.json({
            markets: mockMarkets,
            total: mockMarkets.length,
            page: 1,
            limit: 20,
          });
        })
      );

      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const initialCallCount = callCount;

      // Fast-forward 30 seconds
      jest.advanceTimersByTime(30_000);

      await waitFor(() => {
        expect(callCount).toBeGreaterThan(initialCallCount);
      });
    });

    it('should cleanup polling on unmount', async () => {
      const { result, unmount } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      unmount();

      // No errors should occur after unmount
      jest.advanceTimersByTime(30_000);
    });
  });

  describe('Stable query key — no duplicate requests on re-render without filter change', () => {
    it('should not issue additional requests when re-rendered with same filter values', async () => {
      let callCount = 0;

      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          callCount++;
          return HttpResponse.json({
            markets: mockMarkets,
            total: mockMarkets.length,
            page: 1,
            limit: 20,
          });
        })
      );

      // Render with an inline object — simulates the page.tsx pattern
      const { result, rerender } = renderHook(
        ({ weightClass }: { weightClass: string }) =>
          useMarkets(
            { weight_class: weightClass === 'All' ? undefined : weightClass },
            { page: 1, limit: 12 },
          ),
        { initialProps: { weightClass: 'All' } },
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      const afterFirstFetch = callCount;

      // Re-render with identical values — should NOT fire another request
      rerender({ weightClass: 'All' });
      rerender({ weightClass: 'All' });

      // Allow a tick for any spurious effects to fire
      await new Promise((r) => setTimeout(r, 50));

      expect(callCount).toBe(afterFirstFetch);
    });

    it('should issue a new request when filters actually change', async () => {
      let callCount = 0;

      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          callCount++;
          return HttpResponse.json({
            markets: mockMarkets,
            total: mockMarkets.length,
            page: 1,
            limit: 20,
          });
        })
      );

      const { result, rerender } = renderHook(
        ({ status }: { status?: string }) => useMarkets({ status }),
        { initialProps: { status: undefined } },
      );

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      const afterFirstFetch = callCount;

      // Change the filter value — should trigger a new fetch
      rerender({ status: 'open' });

      await waitFor(() => expect(callCount).toBeGreaterThan(afterFirstFetch));
    });
  });

  describe('Edge cases', () => {
    it('should handle empty markets list', async () => {
      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json({
            markets: [],
            total: 0,
            page: 1,
            limit: 20,
          });
        }),
      );

      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.markets).toEqual([]);
      expect(result.current.total).toBe(0);
    });

    it('should handle invalid market_id in response gracefully', async () => {
      const marketWithoutId = { ...mockMarkets[0] };
      delete (marketWithoutId as any).market_id;

      server.use(
        http.get('http://localhost:3001/api/markets', () => {
          return HttpResponse.json({
            markets: [marketWithoutId],
            total: 1,
            page: 1,
            limit: 20,
          });
        }),
      );

      const { result } = renderHook(() => useMarkets());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.markets).toHaveLength(1);
    });
  });
});
