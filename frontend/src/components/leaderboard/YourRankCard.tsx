'use client';

interface YourRankCardProps {
  /** The caller's rank, 1-indexed. */
  rank: number;
  score?: number;
  xp?: number;
  winRate?: number;
  /** When true, the card emphasises itself because the rank is already visible in the list. */
  isInTopN?: boolean;
}

/**
 * Sticky card pinned to the bottom of the leaderboard. Shows the authenticated
 * caller's own rank so users outside the visible top-N don't have to scroll
 * through every page to find themselves.
 */
export function YourRankCard({ rank, score, xp, winRate, isInTopN = false }: YourRankCardProps): JSX.Element {
  return (
    <div
      className={`sticky bottom-0 z-10 mx-auto mt-4 max-w-3xl rounded-t-xl border-t px-4 py-3 backdrop-blur ${
        isInTopN
          ? 'bg-amber-500/15 border-amber-500/50'
          : 'bg-gray-900/95 border-gray-700'
      }`}
      role="status"
      aria-live="polite"
      data-testid="your-rank-card"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-gray-400">Your rank</span>
        <div className="flex items-center gap-4">
          {(xp !== undefined || score !== undefined) && (
            <span className="text-sm text-gray-300">XP: <strong className="text-white">{xp ?? score}</strong></span>
          )}
          {winRate !== undefined && (
            <span className="text-sm text-gray-300">Win Rate: <strong className="text-white">{winRate}%</strong></span>
          )}
          <span className="text-lg font-bold text-amber-400" data-testid="your-rank-value">
            #{rank}
          </span>
        </div>
      </div>
    </div>
  );
}