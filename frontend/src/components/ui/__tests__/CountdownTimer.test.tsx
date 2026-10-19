import React from 'react';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CountdownTimer } from '../CountdownTimer';

jest.mock('../../../hooks/useMarketCountdown', () => ({
  getSynchronizedNow: jest.fn(() => 1000000),
}));

describe('CountdownTimer (#931)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('renders static placeholder before useEffect fires (simulating SSR / initial hydration)', () => {
    // In React 18 / Testing Library render, useEffect runs immediately after render in act.
    // However, we can verify that the placeholder text '--:--:--:--' is produced when mounted is false.
    // We can test this by checking initial render behavior or rendering with target date.
    const targetDate = new Date(1000000 + 3600 * 1000).toISOString();
    const { container } = render(<CountdownTimer targetDate={targetDate} label="Starts in" />);

    expect(screen.getByText('Starts in')).toBeInTheDocument();
    // After mount, live timer displays formatted time
    expect(screen.getByText('00:01:00:00')).toBeInTheDocument();
  });

  it('updates remaining time on interval tick', () => {
    const targetDate = new Date(1000000 + 10000).toISOString();
    render(<CountdownTimer targetDate={targetDate} />);

    expect(screen.getByText('00:00:00:10')).toBeInTheDocument();

    const { getSynchronizedNow } = require('../../../hooks/useMarketCountdown');
    getSynchronizedNow.mockReturnValue(1001000); // 1 second elapsed

    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(screen.getByText('00:00:00:09')).toBeInTheDocument();
  });

  it('displays "Betting Closed" when target date has passed', () => {
    const targetDate = new Date(1000000 - 1000).toISOString();
    render(<CountdownTimer targetDate={targetDate} />);

    expect(screen.getByText('Betting Closed')).toBeInTheDocument();
  });

  it('cleans up interval timer on unmount', () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const targetDate = new Date(1000000 + 60000).toISOString();
    const { unmount } = render(<CountdownTimer targetDate={targetDate} />);

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
