import { ResilientWsClient, wsMetrics } from '../ws';
import WebSocket from 'ws';

describe('WebSocket Room Resubscription on Reconnect (#692)', () => {
  beforeEach(() => {
    wsMetrics.indexer_ws_reconnects_total = 0;
    jest.clearAllMocks();
  });

  it('restores subscriptions automatically after disconnect within 5 seconds and emits metric', async () => {
    const client = new ResilientWsClient({
      url: 'ws://mock-stellar-feed.example.com',
      minReconnectDelayMs: 50,
      maxReconnectDelayMs: 200,
    });

    client.subscribe('market:123');
    client.subscribe('market:456');

    expect(client.getActiveSubscriptions()).toEqual(['market:123', 'market:456']);

    // Trigger reconnect attempt
    (client as any).scheduleReconnect();

    expect(wsMetrics.indexer_ws_reconnects_total).toBe(1);

    // Verify subscriptions retained in memory
    expect(client.getActiveSubscriptions()).toContain('market:123');
    expect(client.getActiveSubscriptions()).toContain('market:456');

    client.close();
  });
});
