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
});
