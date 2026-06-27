import { check } from 'k6';
import ws from 'k6/ws';

const WS_URL = __ENV.WS_URL || 'ws://localhost:3001';

const MARKET_COUNT = 20;
const MARKET_IDS = Array.from({ length: MARKET_COUNT }, (_, i) => `loadtest-mkt-${i}`);

export const options = {
  scenarios: {
    connections: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 1000 },
        { duration: '2m', target: 1000 },
        { duration: '30s', target: 0 },
      ],
      gracefulStop: '10s',
    },
  },
  thresholds: {
    ws_connecting: ['p(99) < 100'],
    ws_sessions: ['count > 0'],
  },
};

export default function () {
  const selected = [];
  while (selected.length < 5) {
    const m = MARKET_IDS[Math.floor(Math.random() * MARKET_COUNT)];
    if (!selected.includes(m)) selected.push(m);
  }

  const res = ws.connect(WS_URL, {}, function (socket) {
    socket.on('open', function () {
      for (const marketId of selected) {
        socket.send(JSON.stringify({ type: 'subscribe_activity', marketId }));
      }
    });

    socket.on('message', function () {
    });

    socket.on('error', function (e) {
      console.error(`WS error: ${JSON.stringify(e)}`);
    });

    socket.setTimeout(function () {
      socket.close();
    }, 65000);
  });

  check(res, { 'WebSocket handshake succeeded': (r) => r.status === 101 });
}
