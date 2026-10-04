import { renderHook, act } from '@testing-library/react';
import { useMarketOdds } from '../useMarketOdds';
import * as api from '../../lib/api';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  send = jest.fn();
  close = jest.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.onopen?.();
    }, 0);
  }
}

describe('useMarketOdds with WebSocket', () => {
  const originalWebSocket = window.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    (window as any).WebSocket = MockWebSocket;
    jest.spyOn(api, 'fetchOdds').mockResolvedValue({
      fighter_a: { price: 1.5, implied_probability: 0.6 },
      fighter_b: { price: 2.5, implied_probability: 0.4 },
    } as any);
  });

  afterEach(() => {
    window.WebSocket = originalWebSocket;
    jest.restoreAllMocks();
  });

  it('subscribes to market:odds_update via WebSocket and reflects incoming real-time odds', async () => {
    const { result } = renderHook(() => useMarketOdds('market-123', 'open'));

    // Wait for initial render and WS setup
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();

    // Simulate incoming WebSocket odds update
    const updatedOdds = {
      fighter_a: { price: 1.8, implied_probability: 0.55 },
      fighter_b: { price: 2.2, implied_probability: 0.45 },
    };

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'market:odds_update',
          marketId: 'market-123',
          odds: updatedOdds,
        }),
      } as MessageEvent);
    });

    expect(result.current.odds).toEqual(updatedOdds);
    expect(result.current.isStale).toBe(false);
  });
});
