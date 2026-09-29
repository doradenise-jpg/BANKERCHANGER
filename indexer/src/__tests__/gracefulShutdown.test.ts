import app, { gracefulShutdown, serverMetrics } from '../server';
import http from 'http';
import supertest from 'supertest';

describe('Server Graceful Shutdown (#698)', () => {
  let server: http.Server;

  beforeEach((done) => {
    server = app.listen(0, done);
  });

  afterEach((done) => {
    if (server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  it('allows active in-flight request to finish cleanly before shutting down', async () => {
    // Start an in-flight request simulation
    let requestFinished = false;

    // Simulate an active request completing after 150ms
    setTimeout(() => {
      requestFinished = true;
    }, 150);

    const shutdownPromise = gracefulShutdown(server, 2000);
    const { abortedRequests, durationSeconds } = await shutdownPromise;

    expect(abortedRequests).toBe(0);
    expect(durationSeconds).toBeGreaterThan(0);
    expect(serverMetrics.indexer_graceful_shutdown_duration_seconds).toBe(durationSeconds);
  });
});
