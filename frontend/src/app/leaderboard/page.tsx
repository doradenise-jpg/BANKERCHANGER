'use client';

import { useLeaderboard } from '../../hooks/useLeaderboard';
import { useWallet } from '../../hooks/useWallet';
import { YourRankCard } from '../../components/leaderboard/YourRankCard';

export default function LeaderboardPage(): JSX.Element {
  const { leaderboard, myRank, isMyRankInTopN, isLoading, error } = useLeaderboard(50);
  const { address } = useWallet();

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
          {leaderboard.entries.map((entry) => {
            const isCurrentUser =
              !!address && entry.address.toLowerCase() === address.toLowerCase();
            return (
              <li
                key={entry.address}
                className={`flex items-center justify-between rounded-lg px-4 py-2 text-sm transition-colors ${
                  isCurrentUser
                    ? 'bg-gray-800 border-2 border-amber-500'
                    : 'bg-gray-900'
                }`}
              >
                <span className="w-10 text-gray-400">#{entry.rank}</span>
                <span className="flex-1 font-mono text-white flex items-center gap-2">
                  <span>
                    {entry.address.slice(0, 8)}…{entry.address.slice(-4)}
                  </span>
                  {isCurrentUser && (
                    <span className="bg-amber-500 text-black text-xs font-bold px-1.5 py-0.5 rounded">
                      (You)
                    </span>
                  )}
                </span>
                <span className="text-amber-400 font-semibold">{entry.score}</span>
              </li>
            );
          })}
        </ol>
      )}

      {myRank && (
        <YourRankCard
          rank={myRank.rank}
          score={myRank.score}
          xp={myRank.xp}
          winRate={myRank.winRate}
          isInTopN={isMyRankInTopN}
        />
      )}
    </main>
  );
}