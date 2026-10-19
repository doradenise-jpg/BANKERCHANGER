/**
 * Converts a decimal XLM amount to stroops (1 XLM = 10_000_000 stroops).
 *
 * Uses high-precision string manipulation via toFixed(15) to normalize
 * scientific notation (e.g., 1e-7) and avoid floating-point errors.
 * Inputs with >7 decimal places are truncated (not rounded) to match
 * Stellar's on-chain precision of 7 decimal places.
 *
 * @param xlm - XLM amount as a number
 * @returns Equivalent stroops value as a bigint
 *
 * @example
 * xlmToStroops(1)                // 10000000n
 * xlmToStroops(0.1234567)        // 1234567n
 * xlmToStroops(0.1234567890)     // 1234567n (truncated to 7 decimals)
 * xlmToStroops(1e-7)             // 1n (scientific notation normalized)
 * xlmToStroops(0)                // 0n
 */
export function xlmToStroops(xlm: number): bigint {
  // toFixed(15) normalizes scientific notation while preserving
  // the full decimal representation (JS numbers have ~15-17 sig digits)
  const str = xlm.toFixed(15);
  const [whole, frac] = str.split('.');
  // Truncate to 7 decimal places and pad with zeros
  const fracTruncated = frac.slice(0, 7).padEnd(7, '0');
  return BigInt(whole) * 10_000_000n + BigInt(fracTruncated);
}

/**
 * Converts stroops to a decimal XLM number.
 *
 * @param stroops - Stroops value as bigint or numeric string
 * @returns Equivalent XLM amount as a number
 *
 * @example
 * stroopsToXlm(10000000n)  // 1
 * stroopsToXlm(1234567n)   // 0.1234567
 */
export function stroopsToXlm(stroops: bigint | string): number {
  return Number(BigInt(stroops)) / 10_000_000;
}

/**
 * Formats an XLM number or stroop amount with thousand separators and maximum 2 decimal places.
 */
export function formatXlmAmount(amount: number | bigint | string): string {
  const num = typeof amount === 'bigint' ? Number(amount) / 10_000_000 : Number(amount);
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

