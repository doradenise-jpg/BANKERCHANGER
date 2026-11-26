import { useCallback, useEffect, useRef, useState } from 'react';

export type MarketEventType =
  | 'market_updated'
  | 'market_locked'
  | 'market_resolved'
  | 'market_cancelled';

export interface MarketEvent {
  type: MarketEventType;
  marketId?: string;
  data?: unknown;
}

export type WebSocketStatus =
  | 'connecting'
  | 'open'
  | 'closed'
  | 'error';

export interface UseWebSocketOptions {
  /** JWT used to authenticate the socket and subscribe to markets. */
  token?: string | null;
  /** Optional explicit WebSocket URL. Defaults to the /ws endpoint. */
  url?: string;
  /** Market IDs to subscribe to after authenticating (and after each reconnect). */
  marketIds?: string[];
  /** Called for every received market event. */
  onEvent?: (event: MarketEvent) => void;
  /** Enable automatic reconnection on disconnect. Defaults to true. */
  reconnect?: boolean;
  /** Base delay (ms) for exponential backoff. Defaults to 1000. */
  reconnectDelay?: number;
  /** Maximum backoff delay (ms). Defaults to 30000. */
  maxReconnectDelay?: number;
}

export interface UseWebSocketResult {
  status: WebSocketStatus;
  lastEvent: MarketEvent | null;
  send: (payload: unknown) => void;
}

const DEFAULT_PATH = '/ws';

function resolveUrl(explicit?: string): string {
  if (explicit) return explicit;
  if (typeof window === 'undefined') return DEFAULT_PATH;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${DEFAULT_PATH}`;
}

/**
 * useWebSocket connects to the backend /ws endpoint, authenticates with the
 * provided JWT, subscribes to market updates, and auto-reconnects on drop.
 */
export function useWebSocket(
  options: UseWebSocketOptions = {},
): UseWebSocketResult {
  const {
    token,
    url,
    marketIds = [],
    onEvent,
    reconnect = true,
    reconnectDelay = 1000,
    maxReconnectDelay = 30000,
  } = options;

  const [status, setStatus] = useState<WebSocketStatus>('closed');
  const [lastEvent, setLastEvent] = useState<MarketEvent | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const shouldReconnectRef = useRef(reconnect);
  const onEventRef = useRef(onEvent);
  const marketIdsKey = JSON.stringify(Array.from(new Set(marketIds)));

  // Keep the latest callback without forcing a reconnect on every render.
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    shouldReconnectRef.current = reconnect;
  }, [reconnect]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const send = useCallback((payload: unknown) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        typeof payload === 'string' ? payload : JSON.stringify(payload),
      );
    }
  }, []);

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      if (!token) {
        setStatus('closed');
        return;
      }

      setStatus('connecting');
      const socket = new WebSocket(resolveUrl(url));
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        attemptsRef.current = 0;
        setStatus('open');

        socket.send(JSON.stringify({ type: 'auth', token }));
        for (const marketId of JSON.parse(marketIdsKey) as string[]) {
          socket.send(`/subscribe market:${marketId}`);
        }
      };

      socket.onmessage = (message: MessageEvent) => {
        if (disposed) return;
        let event: MarketEvent;
        try {
          event = JSON.parse(message.data as string) as MarketEvent;
        } catch {
          return;
        }

        if (
          event.type === 'market_updated' ||
          event.type === 'market_locked' ||
          event.type === 'market_resolved' ||
          event.type === 'market_cancelled'
        ) {
          // eslint-disable-next-line no-console
          console.log('[useWebSocket] event received:', event);
          setLastEvent(event);
          onEventRef.current?.(event);
        }
      };

      socket.onerror = () => {
        if (disposed) return;
        setStatus('error');
      };

      socket.onclose = () => {
        if (disposed) return;
        setStatus('closed');
        socketRef.current = null;

        if (!shouldReconnectRef.current) return;

        const attempt = attemptsRef.current;
        attemptsRef.current = attempt + 1;
        const delay = Math.min(
          reconnectDelay * 2 ** attempt,
          maxReconnectDelay,
        );
        clearReconnectTimer();
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    // Cleanup: prevent leaks by tearing down the socket and timers.
    return () => {
      disposed = true;
      clearReconnectTimer();
      const socket = socketRef.current;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close();
        }
        socketRef.current = null;
      }
    };
  }, [token, url, marketIdsKey, reconnectDelay, maxReconnectDelay, clearReconnectTimer]);

  return { status, lastEvent, send };
}

export default useWebSocket;
