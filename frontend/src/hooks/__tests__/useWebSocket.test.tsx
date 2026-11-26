/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { useWebSocket } from '../useWebSocket';

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = jest.fn();
  close = jest.fn();

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('useWebSocket', () => {
  const originalWebSocket = window.WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.instances = [];
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    window.WebSocket = originalWebSocket;
    global.WebSocket = originalWebSocket;
    jest.useRealTimers();
  });

  it('authenticates and resubscribes to every market after reconnecting', () => {
    const { unmount } = renderHook(() =>
      useWebSocket({
        token: 'jwt-token',
        marketIds: ['market-1', 'market-2'],
        reconnectDelay: 10,
      }),
    );

    const firstSocket = MockWebSocket.instances[0];
    act(() => firstSocket.open());
    expect(firstSocket.send.mock.calls).toEqual([
      [JSON.stringify({ type: 'auth', token: 'jwt-token' })],
      ['/subscribe market:market-1'],
      ['/subscribe market:market-2'],
    ]);

    act(() => {
      firstSocket.disconnect();
      jest.advanceTimersByTime(10);
    });

    const reconnectedSocket = MockWebSocket.instances[1];
    act(() => reconnectedSocket.open());
    expect(reconnectedSocket.send.mock.calls).toEqual(firstSocket.send.mock.calls);

    unmount();
  });
});
