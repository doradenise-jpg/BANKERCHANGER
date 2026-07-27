/**
 * Converts XLM (Stellar Lumens) amount to stroops (smallest unit).
 * 1 XLM = 10,000,000 stroops (7 decimal places)
 *
 * @param xlm - XLM amount as a number
 * @returns BigInt representing stroops
 *
 * @throws Error if the input is invalid (NaN, Infinity, negative without explicit support)
 *
 * @example
 * xlmToStroops(1) → 10000000n
 * xlmToStroops(0.1234567) → 1234567n
 * xlmToStroops(0.12345678) → 1234567n // Truncates to 7 decimals
 * xlmToStroops(0) → 0n
 */
export function xlmToStroops(xlm: number): bigint {
  // Validate input
  if (!Number.isFinite(xlm)) {
    throw new Error(`Invalid XLM amount: ${xlm}. Must be a finite number.`);
  }

  if (xlm < 0) {
    throw new Error(`Invalid XLM amount: ${xlm}. Cannot be negative.`);
  }

  // Convert to string (handles both regular decimals and scientific notation)
  const xlmStr = xlm.toString();

  // Split on decimal point
  const [whole, frac = ''] = xlmStr.split('.');

  // Whole part: multiply by 10,000,000
  const wholeBigInt = BigInt(whole) * BigInt(10_000_000);

  // Fractional part: take first 7 digits, pad with zeros if needed
  // slice(0, 7) truncates anything beyond 7 decimals (satoshi rounding)
  const fracPadded = frac.slice(0, 7).padEnd(7, '0');
  const fracBigInt = BigInt(fracPadded);

  return wholeBigInt + fracBigInt;
}

/**
 * Converts stroops to XLM.
 * 1 stroop = 0.0000001 XLM
 *
 * @param stroops - Amount in stroops as a BigInt or number
 * @returns XLM amount as a number
 *
 * @example
 * stroopsToXlm(10000000n) → 1
 * stroopsToXlm(1234567n) → 0.1234567
 */
export function stroopsToXlm(stroops: bigint | number): number {
  const stroopsBigInt = typeof stroops === 'bigint' ? stroops : BigInt(stroops);
  return Number(stroopsBigInt) / 10_000_000;
}
