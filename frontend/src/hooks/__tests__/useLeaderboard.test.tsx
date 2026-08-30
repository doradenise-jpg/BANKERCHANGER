import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useLeaderboard } from '../../hooks/useLeaderboard';
import { fetchLeaderboard } from '../../services/api';
import type { Leaderboard } from '../../types';

jest.mock('../../services/api', () => ({
  fetchLeaderboard: jest.fn(),
}));

const mockFetchLeaderboard = fetchLeaderboard as jest.Mock;

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

function HookProbe() {
  const { leaderboard } = useLeaderboard(50);
  return (
    <ul>
      {(leaderboard?.entries ?? []).map((e) => (
        <li key={e.address} data-testid="entry">
          {e.rank}:{e.address}:{e.score}
        </li>
      ))}
    </ul>
  );
}

const baseLeaderboard: Leaderboard = {
  updatedAt: new Date().toISOString(),
  entries: [
    { rank: 1, address: 'GALPHA', predictions: 10, score: 20 },
    { rank: 2, address: 'GBETA', predictions: 5, score: 10 },
  ],
};

describe('useLeaderboard', () => {
  const originalWebSocket = window.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    mockFetchLeaderboard.mockResolvedValue(baseLeaderboard);
  });

  afterEach(() => {
    jest.clearAllMocks();
    window.WebSocket = originalWebSocket;
  });

  it('renders entries fetched from the API', async () => {
    render(<HookProbe />);

    await waitFor(() => {
      expect(screen.getAllByTestId('entry')).toHaveLength(2);
    });

    expect(screen.getByText('1:GALPHA:20')).toBeInTheDocument();
    expect(screen.getByText('2:GBETA:10')).toBeInTheDocument();
  });

  it('subscribes to the leaderboard websocket feed', async () => {
    render(<HookProbe />);
    await waitFor(() => expect(screen.getAllByTestId('entry')).toHaveLength(2));

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();
    expect(socket.sentMessages).toContain(JSON.stringify({ type: 'subscribe_leaderboard' }));
  });

  it('updates a rank/score after a leaderboard_rank websocket event', async () => {
    render(<HookProbe />);
    await waitFor(() => expect(screen.getAllByTestId('entry')).toHaveLength(2));

    const socket = MockWebSocket.instances[0];
    socket.emitMessage(JSON.stringify({
      type: 'leaderboard_rank',
      marketId: 'leaderboard',
      address: 'GALPHA',
      rank: 1,
      score: 99,
      timestamp: new Date().toISOString(),
    }));

    await waitFor(() => {
      expect(screen.getByText('1:GALPHA:99')).toBeInTheDocument();
    });
  });
});
