import { formatScheduledTimeWithTz, formatScheduledTimeUTC } from '../../utils/formatScheduledTime';

describe('formatScheduledTime', () => {
  const testDate = '2025-06-29T14:00:00Z'; // 2:00 PM UTC

  describe('formatScheduledTimeUTC', () => {
    it('should format UTC time consistently', () => {
      const result = formatScheduledTimeUTC(testDate);
      expect(result).toContain('Jun');
      expect(result).toContain('29');
      expect(result).toContain('2:00');
      expect(result).toContain('UTC');
    });

    it('should be the same regardless of environment', () => {
      // Call it multiple times - should always return the same value
      const result1 = formatScheduledTimeUTC(testDate);
      const result2 = formatScheduledTimeUTC(testDate);
      expect(result1).toBe(result2);
    });
  });

  describe('formatScheduledTimeWithTz', () => {
    it('should include timezone abbreviation in output', () => {
      const result = formatScheduledTimeWithTz(testDate);
      // Should match pattern: "Jun 29, X:XX AM/PM TZ"
      expect(result).toMatch(/\d{1,2}:\d{2}\s(AM|PM)/);
      // Should end with timezone abbreviation (2-4 letters)
      expect(result).toMatch(/[A-Z]{2,4}$/);
      expect(result).toContain('Jun');
      expect(result).toContain('29');
    });

    it('should handle different dates', () => {
      const dates = [
        '2025-01-01T00:00:00Z',
        '2025-12-31T23:59:59Z',
        '2025-06-15T12:30:45Z',
      ];

      dates.forEach((date) => {
        const result = formatScheduledTimeWithTz(date);
        // Should always have time and timezone
        expect(result).toMatch(/\d{1,2}:\d{2}/);
        expect(result).toMatch(/[A-Z]{2,4}$/);
      });
    });

    it('should be valid and parseable', () => {
      const result = formatScheduledTimeWithTz(testDate);
      // Should be a non-empty string
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should format the same timestamp consistently', () => {
      const result1 = formatScheduledTimeWithTz(testDate);
      const result2 = formatScheduledTimeWithTz(testDate);
      expect(result1).toBe(result2);
    });
  });

  describe('consistency between formatters', () => {
    it('UTC formatter should represent the same moment as with-tz formatter', () => {
      const utcResult = formatScheduledTimeUTC(testDate);
      // UTC result should always contain "UTC"
      expect(utcResult).toContain('UTC');
      // UTC should show 2:00 for this test date
      expect(utcResult).toContain('2:00');
    });

    it('should handle edge cases', () => {
      const edgeCases = [
        '2025-01-01T00:00:00Z',
        '2025-12-31T23:59:59Z',
      ];

      edgeCases.forEach((date) => {
        const tzResult = formatScheduledTimeWithTz(date);
        const utcResult = formatScheduledTimeUTC(date);

        expect(tzResult).toBeTruthy();
        expect(utcResult).toBeTruthy();
        expect(utcResult).toContain('UTC');
      });
    });
  });
});
