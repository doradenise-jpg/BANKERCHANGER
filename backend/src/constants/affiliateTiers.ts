/**
 * Affiliate commission tiers and boundary constants (Issue #674).
 *
 * Tier boundaries are strictly standardized to:
 *   lower <= volume < upper
 *
 * This ensures users at exact boundary numbers receive the higher tier rate
 * without off-by-one discrepancies.
 */

export interface AffiliateTierDefinition {
  tier: 'bronze' | 'silver' | 'gold' | 'platinum' | 'partner';
  lower: number;
  upper: number;
  commissionBps: number; // 100 bps = 1%
  description: string;
}

export const AFFILIATE_TIERS: readonly AffiliateTierDefinition[] = [
  {
    tier: 'bronze',
    lower: 0,
    upper: 10_000,
    commissionBps: 500, // 5%
    description: 'Volume from 0 up to but not including 10,000',
  },
  {
    tier: 'silver',
    lower: 10_000,
    upper: 50_000,
    commissionBps: 750, // 7.5%
    description: 'Volume from 10,000 up to but not including 50,000',
  },
  {
    tier: 'gold',
    lower: 50_000,
    upper: 100_000,
    commissionBps: 1000, // 10%
    description: 'Volume from 50,000 up to but not including 100,000',
  },
  {
    tier: 'platinum',
    lower: 100_000,
    upper: 500_000,
    commissionBps: 1500, // 15%
    description: 'Volume from 100,000 up to but not including 500,000',
  },
  {
    tier: 'partner',
    lower: 500_000,
    upper: Number.POSITIVE_INFINITY,
    commissionBps: 2000, // 20%
    description: 'Volume of 500,000 and above',
  },
] as const;

/**
 * Resolves the affiliate tier using consistent `lower <= volume < upper` boundaries.
 */
export function getTierForVolume(volume: number | bigint): AffiliateTierDefinition {
  const vol = Number(volume);

  for (const def of AFFILIATE_TIERS) {
    if (vol >= def.lower && vol < def.upper) {
      return def;
    }
  }

  return AFFILIATE_TIERS[AFFILIATE_TIERS.length - 1];
}

/**
 * Calculates commission in basis points or stroops for a given volume level.
 */
export function calculateCommissionBps(volume: number | bigint): number {
  return getTierForVolume(volume).commissionBps;
}
