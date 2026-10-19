interface MarketOddsBarProps {
  pool_a: string;
  pool_b: string;
  pool_draw?: string;
  fighter_a: string;
  fighter_b: string;
  draw_enabled?: boolean;
}

function safeBigInt(val?: string): bigint {
  if (!val) return 0n;
  try {
    return BigInt(val);
  } catch {
    return 0n;
  }
}

export function MarketOddsBar({
  pool_a,
  pool_b,
  pool_draw,
  fighter_a,
  fighter_b,
  draw_enabled = false,
}: MarketOddsBarProps): JSX.Element {
  const a = safeBigInt(pool_a);
  const b = safeBigInt(pool_b);
  const d = safeBigInt(pool_draw);
  const total = a + b + d;

  let pA: bigint;
  let pD: bigint;
  let pB: bigint;

  if (total === 0n) {
    // When pool volume is 0, render neutral 50/50 split (or 33/34/33 if draw is configured)
    if (draw_enabled) {
      pA = 33n;
      pD = 34n;
      pB = 33n;
    } else {
      pA = 50n;
      pD = 0n;
      pB = 50n;
    }
  } else {
    pA = (a * 100n) / total;
    pD = (d * 100n) / total;
    pB = 100n - pA - pD;
  }

  const segments = [
    { label: fighter_a, pct: pA, color: 'bg-blue-600' },
    ...(pD > 0n ? [{ label: 'Draw', pct: pD, color: 'bg-yellow-500' }] : []),
    { label: fighter_b, pct: pB, color: 'bg-red-600' },
  ];

  return (
    <div className="flex w-full h-8 rounded overflow-hidden" data-testid="market-odds-bar">
      {segments.map(({ label, pct: p, color }) => (
        <div
          key={label}
          className={`${color} flex items-center justify-center overflow-hidden transition-[width] duration-[400ms] ease-in-out`}
          style={{ width: `${p}%` }}
        >
          {p >= 10n && (
            <span className="text-white text-xs font-semibold truncate px-1">
              {label} {p.toString()}%
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
