'use client';

import { useLeaderboard } from '../../hooks/useLeaderboard';
import { YourRankCard } from '../../components/leaderboard/YourRankCard';

export default function LeaderboardPage(): JSX.Element {
  const { leaderboard, myRank, isMyRankInTopN, isLoading, error } = useLeaderboard(50);

  return (
    <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
      <h1 className="text-2xl font-black text-white">Leaderboard</h1>

      {isLoading && <p className="text-gray-400">Loading…</p>}
      {error && !isLoading && <p className="text-red-400">Failed to load leaderboard.</p>}

      {leaderboard && leaderboard.entries.length === 0 && !isLoading && (
        <p className="text-gray-500 text-center py-12">No rankings yet.</p>
      )}

      {leaderboard && leaderboard.entries.length > 0 && (
        <ol className="space-y-1">
          {leaderboard.entries.map((entry) => (
            <li
              key={entry.address}
              className="flex items-center justify-between rounded-lg bg-gray-900 px-4 py-2 text-sm"
            >
              <span className="w-10 text-gray-400">#{entry.rank}</span>
              <span className="flex-1 font-mono text-white">
                {entry.address.slice(0, 8)}…{entry.address.slice(-4)}
              </span>
              <span className="text-amber-400 font-semibold">{entry.score}</span>
            </li>
          ))}
        </ol>
      )}

      {myRank && <YourRankCard rank={myRank.rank} isInTopN={isMyRankInTopN} />}
    </main>
  );
}