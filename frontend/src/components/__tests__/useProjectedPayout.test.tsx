import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useProjectedPayout } from '../../hooks/useProjectedPayout';
import type { Market } from '../../types';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  public listeners: Record<string, Array<(event: MessageEvent) => void>> = {};
  public readyState = 1;
  public sentMessages: string[] = [];
  public close = jest.fn();

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    this.listeners[type] = this.listeners[type] ?? [];
    this.listeners[type].push(handler);
  }

  send(message: string) {
    this.sentMessages.push(message);
  }

  emitMessage(payload: string) {
    this.listeners.message?.forEach((handler) => handler({ data: payload } as MessageEvent));
  }
}

function HookProbe({
  market,
  side,
  amount,
}: {
  market: Market;
  side: 'fighter_a' | 'fighter_b' | 'draw';
  amount: number;
}) {
  const payout = useProjectedPayout(market, side, amount);
  return <div data-testid="payout">{payout == null ? 'null' : payout.toFixed(4)}</div>;
}

describe('useProjectedPayout', () => {
  const originalWebSocket = window.WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.instances = [];
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    window.WebSocket = originalWebSocket;
  });

  it('updates projected payout after receiving a websocket trade event', async () => {
    const market: Market = {
      id: 1,
      market_id: 'market-1',
      contract_address: 'CA-market-1',
      match_id: 'match-1',
      fighter_a: 'Alpha',
      fighter_b: 'Beta',
      weight_class: 'Heavyweight',
      title_fight: false,
      venue: 'Arena',
      scheduled_at: new Date().toISOString(),
      status: 'open',
      outcome: null,
      pool_a: '1000000000',
      pool_b: '1000000000',
      pool_draw: '1000000000',
      total_pool: '3000000000',
      fee_bps: 200,
      resolved_at: null,
      oracle_used: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ledger_sequence: 1,
      odds_a: 5000,
      odds_b: 5000,
      odds_draw: 0,
    };

    render(<HookProbe market={market} side="fighter_a" amount={10} />);

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();
    expect(socket.sentMessages).toContain(JSON.stringify({ type: 'subscribe_activity', marketId: 'market-1' }));

    const initialPayout = screen.getByTestId('payout').textContent;
    expect(initialPayout).toBeTruthy();

    socket.emitMessage(JSON.stringify({
      type: 'trade',
      marketId: 'market-1',
      outcomeId: 'fighter_a',
      side: 'buy',
      sharesAmount: 50,
      priceBps: 1000,
      timestamp: '2024-01-01T00:00:00.000Z',
    }));

    jest.advanceTimersByTime(1000);

    await waitFor(() => {
      expect(screen.getByTestId('payout').textContent).not.toBe(initialPayout);
    });
  });
});
