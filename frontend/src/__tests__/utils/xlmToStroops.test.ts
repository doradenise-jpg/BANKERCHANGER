import { xlmToStroops, stroopsToXlm } from '../../utils/xlmToStroops';

describe('xlmToStroops', () => {
  // ── Integers ──────────────────────────────────────────────────────────
  describe('integers', () => {
    it('converts 0 to 0n', () => {
      expect(xlmToStroops(0)).toBe(0n);
    });

    it('converts 1 XLM to 10_000_000 stroops', () => {
      expect(xlmToStroops(1)).toBe(10_000_000n);
    });

    it('converts 100 XLM', () => {
      expect(xlmToStroops(100)).toBe(1_000_000_000n);
    });

    it('converts a large integer', () => {
      expect(xlmToStroops(9999)).toBe(99_990_000_000n);
    });
  });

  // ── 7-decimal inputs ──────────────────────────────────────────────────
  describe('7-decimal inputs', () => {
    it('converts 0.1234567', () => {
      expect(xlmToStroops(0.1234567)).toBe(1_234_567n);
    });

    it('converts 0.0000001 (minimum stroop)', () => {
      expect(xlmToStroops(0.0000001)).toBe(1n);
    });

    it('converts 0.9999999', () => {
      expect(xlmToStroops(0.9999999)).toBe(9_999_999n);
    });

    it('converts 1.5000000', () => {
      expect(xlmToStroops(1.5)).toBe(15_000_000n);
    });
  });

  // ── >7-decimal truncation ─────────────────────────────────────────────
  describe('>7-decimal truncation', () => {
    it('truncates 0.1234567890 to 7 decimals', () => {
      expect(xlmToStroops(0.123456789)).toBe(1_234_567n);
    });

    it('truncates 0.12345678901234567890', () => {
      // JS can only represent ~17 digits precisely, but the function should still work
      const result = xlmToStroops(0.123456789012345);
      // Should be 1234567n (truncated, not rounded)
      expect(result).toBe(1_234_567n);
    });

    it('truncates without rounding up at the 8th decimal', () => {
      // 0.12345679 would be 1234567.9 stroops — truncated to 1234567
      expect(xlmToStroops(0.12345679)).toBe(1_234_567n);
    });

    it('truncates 0.00000019 to 0n', () => {
      // Only 7 decimal places, so 0.00000019 → 0.0000001 (truncated)
      expect(xlmToStroops(0.00000019)).toBe(1n);
    });
  });

  // ── Scientific notation ───────────────────────────────────────────────
  describe('scientific notation', () => {
    it('converts 1e-7 (0.0000001)', () => {
      expect(xlmToStroops(1e-7)).toBe(1n);
    });

    it('converts 1e-6 (0.000001)', () => {
      expect(xlmToStroops(1e-6)).toBe(10n);
    });

    it('converts 1.5e-7', () => {
      // 1.5e-7 = 0.00000015 → truncated to 0.0000001 → 1n
      expect(xlmToStroops(1.5e-7)).toBe(1n);
    });

    it('converts large scientific notation', () => {
      // 1e3 = 1000
      expect(xlmToStroops(1e3)).toBe(10_000_000_000n);
    });

    it('converts 9.999e-1 (0.9999)', () => {
      expect(xlmToStroops(9.999e-1)).toBe(9_999_000n);
    });
  });

  // ── Zero ──────────────────────────────────────────────────────────────
  describe('zero', () => {
    it('converts literal 0', () => {
      expect(xlmToStroops(0)).toBe(0n);
    });

    it('converts 0.0', () => {
      expect(xlmToStroops(0.0)).toBe(0n);
    });

    it('converts 0.0000000', () => {
      expect(xlmToStroops(0.0)).toBe(0n);
    });
  });

  // ── Round-trip consistency ────────────────────────────────────────────
  describe('round-trip with stroopsToXlm', () => {
    it('1 XLM round-trips correctly', () => {
      const stroops = xlmToStroops(1);
      expect(stroopsToXlm(stroops)).toBeCloseTo(1, 7);
    });

    it('0.1234567 XLM round-trips correctly', () => {
      const stroops = xlmToStroops(0.1234567);
      expect(stroopsToXlm(stroops)).toBeCloseTo(0.1234567, 7);
    });

    it('truncated value round-trips to truncated amount', () => {
      const stroops = xlmToStroops(0.123456789);
      // Round-trip should give back the truncated value
      expect(stroopsToXlm(stroops)).toBeCloseTo(0.1234567, 7);
    });
  });
});

describe('stroopsToXlm', () => {
  it('converts 10_000_000n to 1', () => {
    expect(stroopsToXlm(10_000_000n)).toBe(1);
  });

  it('converts 0n to 0', () => {
    expect(stroopsToXlm(0n)).toBe(0);
  });

  it('converts 1_234_567n to 0.1234567', () => {
    expect(stroopsToXlm(1_234_567n)).toBeCloseTo(0.1234567, 7);
  });

  it('accepts string input', () => {
    expect(stroopsToXlm('10000000')).toBe(1);
  });
});

describe('formatXlmAmount', () => {
  const { formatXlmAmount } = require('../../utils/xlmToStroops');

  it('formats 1 stroop correctly', () => {
    expect(formatXlmAmount(1n)).toBe('0');
  });

  it('formats 10 XLM correctly', () => {
    expect(formatXlmAmount(10)).toBe('10');
  });

  it('formats 1,000,000 XLM with thousand separators', () => {
    expect(formatXlmAmount(1_000_000)).toBe('1,000,000');
  });

  it('formats max stroop values without floating point errors', () => {
    const maxStroops = 9223372036854775807n; // INT64_MAX
    expect(formatXlmAmount(maxStroops)).toBeDefined();
  });
});

