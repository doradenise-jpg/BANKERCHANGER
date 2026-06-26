import { renderHook, act } from '@testing-library/react';
import { useMarketCountdown } from '../../hooks/useMarketCountdown';

const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();

describe('useMarketCountdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('cleanup on unmount', () => {
    it('calls clearInterval with the correct ID when the component unmounts', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      const { unmount } = renderHook(() => useMarketCountdown(fromNow(10_000)));

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const registeredId = setIntervalSpy.mock.results[0].value;

      unmount();

      expect(clearIntervalSpy).toHaveBeenCalledWith(registeredId);

      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
    });

    it('does not tick after unmount — no console errors about unmounted state updates', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const { unmount } = renderHook(() => useMarketCountdown(fromNow(10_000)));

      unmount();

      act(() => {
        jest.advanceTimersByTime(5_000);
      });

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('return values', () => {
    it('returns "Xh Ym Zs" format for times more than one hour away', () => {
      const { result } = renderHook(() =>
        useMarketCountdown(fromNow(2 * 3600_000 + 14 * 60_000 + 32_000)),
      );
      expect(result.current).toMatch(/^\d+h \d+m \d+s$/);
    });

    it('returns "Xm Ys" format for times less than one hour away', () => {
      const { result } = renderHook(() => useMarketCountdown(fromNow(14 * 60_000 + 32_000)));
      expect(result.current).toMatch(/^\d+m \d+s$/);
    });

    it('returns "Xs" format for times less than one minute away', () => {
      const { result } = renderHook(() => useMarketCountdown(fromNow(45_000)));
      expect(result.current).toMatch(/^\d+s$/);
    });

    it('returns "LIVE" when scheduled time is in the past but within resolution window', () => {
      const { result } = renderHook(() => useMarketCountdown(fromNow(-1_000)));
      expect(result.current).toBe('LIVE');
    });

    it('returns "ENDED" when past the 24-hour resolution window', () => {
      const { result } = renderHook(() => useMarketCountdown(fromNow(-25 * 3600_000)));
      expect(result.current).toBe('ENDED');
    });

    it('decrements by one second per tick', () => {
      const { result } = renderHook(() => useMarketCountdown(fromNow(10_000)));
      const initial = result.current;

      act(() => {
        jest.advanceTimersByTime(1_000);
      });

      expect(result.current).not.toBe(initial);
    });

    it('transitions from countdown to "LIVE" when the time arrives', () => {
      const { result } = renderHook(() => useMarketCountdown(fromNow(2_000)));
      expect(result.current).not.toBe('LIVE');

      act(() => {
        jest.advanceTimersByTime(3_000);
      });

      expect(result.current).toBe('LIVE');
    });
  });
});
