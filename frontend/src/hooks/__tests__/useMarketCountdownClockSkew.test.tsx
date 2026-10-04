import { renderHook, act, render, screen } from '@testing-library/react';
import React from 'react';
import {
  useMarketCountdown,
  syncServerTimeOffset,
  useServerClockSkew,
  ClockWarningBanner,
} from '../useMarketCountdown';

describe('useMarketCountdown and Server Clock Synchronization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calculates clock offset correctly from /api/time', async () => {
    const clientTime = 1000000;
    const serverTime = 1070000; // 70 seconds ahead (> 60s skew)

    jest.spyOn(Date, 'now').mockReturnValue(clientTime);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ serverTime }),
    } as any);

    const offset = await syncServerTimeOffset();
    expect(offset).toBe(70000);
    expect(global.fetch).toHaveBeenCalledWith('/api/time');
  });

  it('warns user via ClockWarningBanner when system clock differs by > 60 seconds', async () => {
    const clientTime = 1000000;
    const serverTime = 1080000; // 80s skew

    jest.spyOn(Date, 'now').mockReturnValue(clientTime);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ serverTime }),
    } as any);

    render(<ClockWarningBanner />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/system clock differs from the server by more than 60 seconds/i);
  });
});
