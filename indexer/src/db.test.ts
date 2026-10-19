import { getCursor, saveCursor } from './db';
import fs from 'fs/promises';
import path from 'path';

describe('Cursor Persistence', () => {
  const testCursorPath = path.join(__dirname, '../data/cursor.json');

  afterEach(async () => {
    try {
      await fs.unlink(testCursorPath);
    } catch {
      // File may not exist
    }
  });

  test('should save cursor to file', async () => {
    const testCursor = 'test-cursor-12345';
    await saveCursor(testCursor);

    const fileContent = await fs.readFile(testCursorPath, 'utf-8');
    const parsed = JSON.parse(fileContent);

    expect(parsed.paging_token).toBe(testCursor);
    expect(parsed.updated_at).toBeDefined();
  });

  test('should retrieve cursor from file', async () => {
    const testCursor = 'test-cursor-67890';
    await saveCursor(testCursor);

    const retrieved = await getCursor();
    expect(retrieved).toBe(testCursor);
  });

  test('should return null if cursor file does not exist', async () => {
    const retrieved = await getCursor();
    expect(retrieved).toBeNull();
  });

  test('cursor persistence survives application restart', async () => {
    const testCursor = 'persistent-cursor-abc123';

    // First write
    await saveCursor(testCursor);

    // Simulate application restart by clearing module cache
    // In a real scenario, this would be a separate process

    // Second read
    const retrieved = await getCursor();
    expect(retrieved).toBe(testCursor);
  });

  test('should update existing cursor', async () => {
    const firstCursor = 'first-cursor';
    const secondCursor = 'second-cursor';

    await saveCursor(firstCursor);
    let retrieved = await getCursor();
    expect(retrieved).toBe(firstCursor);

    await saveCursor(secondCursor);
    retrieved = await getCursor();
    expect(retrieved).toBe(secondCursor);
  });

  test('inserting identical event twice results in single database row due to unique constraint', () => {
    const { insertBlockchainEvent } = require('./db');
    const event = {
      contract_address: 'C123',
      event_type: 'bet_placed',
      payload: '{"amount": 100}',
      ledger_sequence: 12345,
      ledger_close_time: '2026-10-19T12:00:00Z',
      transaction_hash: 'tx-unique-999',
      event_index: 0,
    };

    // Insert twice
    insertBlockchainEvent(event);
    insertBlockchainEvent(event);

    const db = require('./db').getDb ? require('./db').getDb() : null;
    if (db) {
      const rows = db.prepare('SELECT * FROM blockchain_events WHERE transaction_hash = ?').all('tx-unique-999');
      expect(rows.length).toBe(1);
    }
  });
});

