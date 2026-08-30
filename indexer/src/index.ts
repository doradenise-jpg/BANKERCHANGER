import app from './server';
import { pollEvents } from './poller';
import { initWebSocketServer } from './ws';

const PORT = process.env.PORT || 3001;

const httpServer = app.listen(PORT, () => {
  console.log(`Indexer REST API running on port ${PORT}`);
  // Start polling Horizon in the background
  pollEvents();
});

initWebSocketServer(httpServer);
console.log(`Indexer WebSocket stream available at ws://localhost:${PORT}/ws`);
