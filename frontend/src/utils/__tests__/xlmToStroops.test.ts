import { xlmToStroops, stroopsToXlm } from '../xlmToStroops';

describe('xlmToStroops', () => {
  // ─── Basic conversion tests ──────────────────────────────────────────────
  describe('basic conversions', () => {
    it('should convert 0 to 0 stroops', () => {
      expect(xlmToStroops(0)).toBe(0n);
    });

    it('should convert 1 XLM to 10,000,000 stroops', () => {
      expect(xlmToStroops(1)).toBe(10_000_000n);
    });

    it('should convert 2 XLM to 20,000,000 stroops', () => {
      expect(xlmToStroops(2)).toBe(20_000_000n);
    });

    it('should convert 100 XLM to 1,000,000,000 stroops', () => {
      expect(xlmToStroops(100)).toBe(1_000_000_000n);
    });

    it('should convert large integer amounts', () => {
      expect(xlmToStroops(1_000_000)).toBe(10_000_000_000_000n);
    });
  });

  // ─── Decimal conversion tests ────────────────────────────────────────────
  describe('decimal conversions (7 decimals or less)', () => {
    it('should convert 0.1 XLM to 1,000,000 stroops', () => {
      expect(xlmToStroops(0.1)).toBe(1_000_000n);
    });

    it('should convert 0.01 XLM to 100,000 stroops', () => {
      expect(xlmToStroops(0.01)).toBe(100_000n);
    });

    it('should convert 0.001 XLM to 10,000 stroops', () => {
      expect(xlmToStroops(0.001)).toBe(10_000n);
    });

    it('should convert 0.0001 XLM to 1,000 stroops', () => {
      expect(xlmToStroops(0.0001)).toBe(1_000n);
    });

    it('should convert 0.00001 XLM to 100 stroops', () => {
      expect(xlmToStroops(0.00001)).toBe(100n);
    });

    it('should convert 0.000001 XLM to 10 stroops', () => {
      expect(xlmToStroops(0.000001)).toBe(10n);
    });

    it('should convert 0.0000001 XLM to 1 stroop (minimum)', () => {
      expect(xlmToStroops(0.0000001)).toBe(1n);
    });

    it('should convert 0.1234567 XLM (exactly 7 decimals)', () => {
      expect(xlmToStroops(0.1234567)).toBe(1_234_567n);
    });

    it('should convert 1.5 XLM to 15,000,000 stroops', () => {
      expect(xlmToStroops(1.5)).toBe(15_000_000n);
    });

    it('should convert 10.5555555 XLM (7 decimals)', () => {
      expect(xlmToStroops(10.5555555)).toBe(105_555_555n);
    });
  });

  // ─── Truncation tests (>7 decimals) ──────────────────────────────────────
  describe('truncation of decimals beyond 7 places', () => {
    it('should truncate 0.12345678 to 0.1234567 stroops', () => {
      // 8 decimal places: should drop the last '8'
      expect(xlmToStroops(0.12345678)).toBe(1_234_567n);
    });

    it('should truncate 0.123456789 to 0.1234567 stroops', () => {
      // 9 decimal places: should drop '89'
      expect(xlmToStroops(0.123456789)).toBe(1_234_567n);
    });

    it('should truncate 0.1234567890 to 0.1234567 stroops', () => {
      // 10 decimal places: should drop '890'
      expect(xlmToStroops(0.1234567890)).toBe(1_234_567n);
    });

    it('should truncate 1.99999999 to 1.9999999 stroops', () => {
      // 8 decimal places: drop last '9'
      expect(xlmToStroops(1.99999999)).toBe(19_999_999n);
    });

    it('should truncate 0.0000001999 to 0.0000001 stroops', () => {
      // Drop everything after 7th decimal
      expect(xlmToStroops(0.0000001999)).toBe(1n);
    });

    it('should truncate 50.123456789012345 to 50.1234567 stroops', () => {
      // Many decimals: should drop all after 7th
      expect(xlmToStroops(50.123456789012345)).toBe(501_234_567n);
    });
  });

  // ─── Scientific notation tests ───────────────────────────────────────────
  describe('scientific notation', () => {
    it('should convert 1e0 (1) to 10,000,000 stroops', () => {
      expect(xlmToStroops(1e0)).toBe(10_000_000n);
    });

    it('should convert 1e1 (10) to 100,000,000 stroops', () => {
      expect(xlmToStroops(1e1)).toBe(100_000_000n);
    });

    it('should convert 1e-1 (0.1) to 1,000,000 stroops', () => {
      expect(xlmToStroops(1e-1)).toBe(1_000_000n);
    });

    it('should convert 1e-2 (0.01) to 100,000 stroops', () => {
      expect(xlmToStroops(1e-2)).toBe(100_000n);
    });

    it('should convert 1e-7 (0.0000001) to 1 stroop', () => {
      expect(xlmToStroops(1e-7)).toBe(1n);
    });

    it('should convert 1.5e2 (150) to 1,500,000,000 stroops', () => {
      expect(xlmToStroops(1.5e2)).toBe(1_500_000_000n);
    });

    it('should convert 2.5e-1 (0.25) to 2,500,000 stroops', () => {
      expect(xlmToStroops(2.5e-1)).toBe(2_500_000n);
    });

    it('should handle very small scientific notation 1e-8', () => {
      // 0.00000001 - should truncate to 0
      expect(xlmToStroops(1e-8)).toBe(0n);
    });

    it('should handle large scientific notation 1e6', () => {
      // 1,000,000 XLM
      expect(xlmToStroops(1e6)).toBe(10_000_000_000_000n);
    });
  });

  // ─── Edge cases and error handling ───────────────────────────────────────
  describe('edge cases and error handling', () => {
    it('should throw error for NaN', () => {
      expect(() => xlmToStroops(NaN)).toThrow(/invalid/i);
    });

    it('should throw error for Infinity', () => {
      expect(() => xlmToStroops(Infinity)).toThrow(/invalid/i);
    });

    it('should throw error for negative Infinity', () => {
      expect(() => xlmToStroops(-Infinity)).toThrow(/invalid/i);
    });

    it('should throw error for negative numbers', () => {
      expect(() => xlmToStroops(-1)).toThrow(/negative/i);
    });

    it('should throw error for negative decimals', () => {
      expect(() => xlmToStroops(-0.5)).toThrow(/negative/i);
    });

    it('should handle very small positive numbers (near zero)', () => {
      expect(xlmToStroops(0.00000001)).toBe(0n);
    });

    it('should handle Number.MIN_VALUE (very small but positive)', () => {
      expect(xlmToStroops(Number.MIN_VALUE)).toBe(0n);
    });
  });

  // ─── Precision and rounding tests ────────────────────────────────────────
  describe('precision and rounding behavior', () => {
    it('should truncate (not round) 0.99999999 to 0.9999999', () => {
      // Truncate, don't round up
      expect(xlmToStroops(0.99999999)).toBe(9_999_999n);
    });

    it('should truncate 0.00000019 to 0.0000001', () => {
      expect(xlmToStroops(0.00000019)).toBe(1n);
    });

    it('should not round 0.12345675 up to 0.1234568', () => {
      // Truncate at 7 decimals, not round
      expect(xlmToStroops(0.12345675)).toBe(1_234_567n);
    });

    it('should maintain precision for 0.0000001 (1 stroop)', () => {
      expect(xlmToStroops(0.0000001)).toBe(1n);
    });

    it('should be consistent for repeated conversions', () => {
      const xlm = 1.2345678;
      const result1 = xlmToStroops(xlm);
      const result2 = xlmToStroops(xlm);
      expect(result1).toBe(result2);
    });
  });

  // ─── Real-world betting scenarios ────────────────────────────────────────
  describe('real-world betting scenarios', () => {
    it('should convert min bet of 0.1 XLM', () => {
      expect(xlmToStroops(0.1)).toBe(1_000_000n);
    });

    it('should convert max bet of 1000 XLM', () => {
      expect(xlmToStroops(1000)).toBe(10_000_000_000_000n);
    });

    it('should convert typical bet of 5.5 XLM', () => {
      expect(xlmToStroops(5.5)).toBe(55_000_000n);
    });

    it('should convert precise bet of 0.0000001 XLM (1 stroop)', () => {
      expect(xlmToStroops(0.0000001)).toBe(1n);
    });

    it('should convert user-input bet like 42.123', () => {
      expect(xlmToStroops(42.123)).toBe(421_230_000n);
    });

    it('should convert API response bet 1.0', () => {
      expect(xlmToStroops(1.0)).toBe(10_000_000n);
    });
  });
});

describe('stroopsToXlm', () => {
  describe('basic conversions', () => {
    it('should convert 0 stroops to 0 XLM', () => {
      expect(stroopsToXlm(0n)).toBe(0);
    });

    it('should convert 10,000,000 stroops to 1 XLM', () => {
      expect(stroopsToXlm(10_000_000n)).toBe(1);
    });

    it('should convert 1,000,000 stroops to 0.1 XLM', () => {
      expect(stroopsToXlm(1_000_000n)).toBe(0.1);
    });

    it('should convert 1 stroop to 0.0000001 XLM', () => {
      expect(stroopsToXlm(1n)).toBe(0.0000001);
    });

    it('should handle number inputs as well as BigInt', () => {
      expect(stroopsToXlm(10_000_000)).toBe(1);
      expect(stroopsToXlm(10_000_000n)).toBe(1);
    });
  });

  describe('round-trip conversions', () => {
    it('should round-trip 1 XLM through stroops and back', () => {
      const original = 1;
      const stroops = xlmToStroops(original);
      const restored = stroopsToXlm(stroops);
      expect(restored).toBe(original);
    });

    it('should round-trip 0.1234567 XLM', () => {
      const original = 0.1234567;
      const stroops = xlmToStroops(original);
      const restored = stroopsToXlm(stroops);
      expect(restored).toBe(original);
    });

    it('should round-trip 5.5 XLM', () => {
      const original = 5.5;
      const stroops = xlmToStroops(original);
      const restored = stroopsToXlm(stroops);
      expect(restored).toBe(original);
    });

    it('should round-trip 100 XLM', () => {
      const original = 100;
      const stroops = xlmToStroops(original);
      const restored = stroopsToXlm(stroops);
      expect(restored).toBe(original);
    });

    it('should round-trip 0.0000001 XLM (minimum)', () => {
      const original = 0.0000001;
      const stroops = xlmToStroops(original);
      const restored = stroopsToXlm(stroops);
      expect(restored).toBe(original);
    });

    it('should handle truncation in round-trip for >7 decimals', () => {
      const original = 0.12345678; // 8 decimals
      const stroops = xlmToStroops(original);
      const restored = stroopsToXlm(stroops);
      expect(restored).toBe(0.1234567); // Truncated to 7 decimals
    });
  });
});
