# WebSocket Connection Manager: First-Message Auth

This module provides a clean, reusable connection manager for the new first-message authentication protocol.

## Installation

```typescript
// frontend/src/hooks/useWebSocket.ts
import { useEffect, useRef, useState, useCallback } from 'react';

interface WebSocketEvent {
  type: string;
  marketId: string;
  [key: string]: any;
}

type WebSocketEventHandler = (event: WebSocketEvent) => void;
type ConnectionState = 'connecting' | 'authenticated' | 'subscribed' | 'closed' | 'error';

/**
 * Manages WebSocket connection with first-message authentication
 * 
 * Usage:
 * ```tsx
 * const { subscribe, unsubscribe, isConnected } = useWebSocket(token);
 * 
 * useEffect(() => {
 *   subscribe('market-123', (event) => {
 *     console.log('Activity:', event);
 *   });
 * }, [subscribe]);
 * ```
 */
export function useWebSocket(authToken: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<ConnectionState>('closed');
  const [error, setError] = useState<string | null>(null);
  const handlersRef = useRef<Map<string, Set<WebSocketEventHandler>>>(new Map());
  const authTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current) {
      console.warn('WebSocket already connected');
      return;
    }

    if (!authToken) {
      setError('No auth token available');
      return;
    }

    setState('connecting');
    setError(null);

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/realtime`;
      
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.addEventListener('open', () => {
        console.log('[WebSocket] Connected, sending auth message');
        
        // Send auth message immediately
        wsRef.current?.send(JSON.stringify({
          type: 'auth',
          token: authToken,
        }));

        // Set timeout for auth response
        authTimeoutRef.current = setTimeout(() => {
          console.error('[WebSocket] Auth timeout');
          setError('Authentication timeout');
          setState('error');
          wsRef.current?.close();
        }, 5000);
      });

      wsRef.current.addEventListener('message', (event) => {
        const message = JSON.parse(event.data) as WebSocketEvent;
        
        // Clear auth timeout on first message after connect
        if (authTimeoutRef.current) {
          clearTimeout(authTimeoutRef.current);
          authTimeoutRef.current = null;
          setState('authenticated');
          console.log('[WebSocket] Authenticated');
        }

        // Dispatch to handlers
        const handlers = handlersRef.current.get(message.marketId);
        if (handlers) {
          handlers.forEach((handler) => {
            try {
              handler(message);
            } catch (err) {
              console.error('[WebSocket] Handler error:', err);
            }
          });
        }
      });

      wsRef.current.addEventListener('close', (event) => {
        console.log(`[WebSocket] Closed: ${event.code} ${event.reason}`);
        wsRef.current = null;
        handlersRef.current.clear();

        if (authTimeoutRef.current) {
          clearTimeout(authTimeoutRef.current);
        }

        // Determine error message based on close code
        if (event.code === 4001) {
          setError('Authentication failed: ' + event.reason);
        } else if (event.code === 4002) {
          setError('Invalid auth message: ' + event.reason);
        } else if (event.code === 1000) {
          // Normal close
          setState('closed');
          setError(null);
          return;
        }

        setState('error');

        // Attempt reconnect with exponential backoff
        if (reconnectAttemptsRef.current < maxReconnectAttempts && authToken) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 10000);
          console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current + 1})`);
          
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttemptsRef.current++;
            connect();
          }, delay);
        }
      });

      wsRef.current.addEventListener('error', (event) => {
        console.error('[WebSocket] Error:', event);
        setError('WebSocket error');
        setState('error');
      });

      reconnectAttemptsRef.current = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[WebSocket] Connection error:', message);
      setError(message);
      setState('error');
    }
  }, [authToken]);

  // Subscribe to market
  const subscribe = useCallback((marketId: string, handler: WebSocketEventHandler) => {
    // Connect if needed
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      connect();
    }

    // Add handler
    if (!handlersRef.current.has(marketId)) {
      handlersRef.current.set(marketId, new Set());
    }
    handlersRef.current.get(marketId)!.add(handler);

    // Send subscription message if authenticated
    if (wsRef.current?.readyState === WebSocket.OPEN && state === 'authenticated') {
      wsRef.current.send(JSON.stringify({
        type: 'subscribe_activity',
        marketId,
      }));
      setState('subscribed');
    }

    // Return unsubscribe function
    return () => unsubscribe(marketId, handler);
  }, [connect, state]);

  // Unsubscribe from market
  const unsubscribe = useCallback((marketId: string, handler: WebSocketEventHandler) => {
    const handlers = handlersRef.current.get(marketId);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        handlersRef.current.delete(marketId);
      }
    }
  }, []);

  // Disconnect
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (authTimeoutRef.current) {
      clearTimeout(authTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    handlersRef.current.clear();
    setState('closed');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  // Auto-connect when token becomes available
  useEffect(() => {
    if (authToken && (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED)) {
      connect();
    }
  }, [authToken, connect]);

  return {
    subscribe,
    unsubscribe,
    disconnect,
    isConnected: state === 'authenticated' || state === 'subscribed',
    state,
    error,
  };
}
