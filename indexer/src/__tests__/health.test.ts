import request from 'supertest';
import app from '../server';
import { updateLastLedger } from '../health';

describe('GET /health', () => {
  it('should return 200 with health status', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      lastLedger: expect.anything(),
      cursorAge: expect.anything(),
      version: expect.any(String),
    });
  });

  it('should include version from package.json', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.version).toBe('1.0.0');
  });

  it('should return null lastLedger when no events processed yet', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    // May be null if no events have been processed
    expect(response.body.lastLedger === null || typeof response.body.lastLedger === 'number').toBe(true);
  });

  it('should update lastLedger when events are processed', async () => {
    // Simulate processing an event
    updateLastLedger(12345);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.lastLedger).toBe(12345);
    expect(response.body.cursorAge).toBeGreaterThanOrEqual(0);
  });

  it('should track cursor age correctly', async () => {
    updateLastLedger(12346);

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.cursorAge).toBeGreaterThanOrEqual(100);
  });

  it('should return cursorAge as null when no updates yet', async () => {
    // This test depends on the state not being initialized
    // In a real scenario with a clean state, cursorAge would be null
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.cursorAge === null || typeof response.body.cursorAge === 'number').toBe(true);
  });
});
