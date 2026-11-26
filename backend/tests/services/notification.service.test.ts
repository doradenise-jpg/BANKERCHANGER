import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('../../src/config/db', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { EngagementService } from '../../src/services/engagement.service';

describe('notification APIs in EngagementService', () => {
  let service: EngagementService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new EngagementService();
  });

  it('returns notifications for the requested address and limit', async () => {
    const notifications = [{ id: 1, title: 'Market resolved' }];
    mockQuery.mockResolvedValueOnce({ rows: notifications });

    await expect(service.getNotifications('GAAA', 10)).resolves.toBe(notifications);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM user_notifications'), ['GAAA', 10]);
  });

  it('returns an empty list when notification storage fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.getNotifications('GAAA')).resolves.toEqual([]);
  });

  it('returns true only when the matching notification was updated', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: null });

    await expect(service.markNotificationRead('GAAA', 1)).resolves.toBe(true);
    await expect(service.markNotificationRead('GAAA', 2)).resolves.toBe(false);
    await expect(service.markNotificationRead('GAAA', 3)).resolves.toBe(false);
  });

  it('preserves the service fallback when marking a notification errors', async () => {
    mockQuery.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.markNotificationRead('GAAA', 1)).resolves.toBe(true);
  });
});
