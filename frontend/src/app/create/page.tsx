'use client';

import { useState, FormEvent, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getConnectedAddress } from '@/services/wallet';
import { TxStatusToast } from '@/components/ui/TxStatusToast';
import type { TxStatus } from '@/types';
import { useCreateMarket } from '@/hooks/useCreateMarket';

const ADMIN_ADDRESSES = (process.env.NEXT_PUBLIC_ADMIN_ADDRESSES ?? '')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);

export default function CreateMarketPage() {
  const router = useRouter();
  const [txStatus, setTxStatus] = useState<TxStatus>({
    hash: null,
    status: 'idle',
    error: null,
  });
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const { createMarket } = useCreateMarket();

  const connectedAddress = getConnectedAddress();
  const isAdmin = connectedAddress && ADMIN_ADDRESSES.includes(connectedAddress);

  // Auth guard: redirect if wallet not connected or not an admin
  useEffect(() => {
    if (!connectedAddress) {
      // Not connected - show message and redirect to home
      const timer = setTimeout(() => {
        router.push('/');
      }, 2000);
      return () => clearTimeout(timer);
    }

    if (!isAdmin) {
      // Connected but not admin - redirect to home
      const timer = setTimeout(() => {
        router.push('/');
      }, 2000);
      return () => clearTimeout(timer);
    }

    // User is authorized
    setIsAuthorized(true);
    setIsLoading(false);
  }, [connectedAddress, isAdmin, router]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);

    const fighterA = data.get('fighterA') as string;
    const fighterB = data.get('fighterB') as string;
    const matchId = data.get('matchId') as string;
    const startTime = data.get('startTime') as string;
    const endTime = data.get('endTime') as string;

    const feeBpsRaw = data.get('feeBps') as string | null;
    const feeBps = feeBpsRaw ? Number(feeBpsRaw) : 0;

    if (!fighterA || !fighterB || !matchId || !startTime || !endTime) {
      setTxStatus({ hash: null, status: 'error', error: 'All required fields must be provided' });
      return;
    }

    const startMs = new Date(startTime).getTime();
    const endMs = new Date(endTime).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      setTxStatus({ hash: null, status: 'error', error: 'Invalid date/time' });
      return;
    }
    if (startMs < Date.now()) {
      setTxStatus({ hash: null, status: 'error', error: 'Start Time must be in the future' });
      return;
    }
    if (endMs <= startMs) {
      setTxStatus({ hash: null, status: 'error', error: 'End Time must be after Start Time' });
      return;
    }
    if (!Number.isFinite(feeBps) || feeBps < 0) {
      setTxStatus({ hash: null, status: 'error', error: 'Fee BPS must be >= 0' });
      return;
    }

    // NOTE: smart-contract call requires additional fields.
    // We derive safe defaults from existing form semantics:
    // - schedule_at uses Start Time
    // - lockBeforeMinutes is computed from (Start - now)
    // - min/max bet and weight/venue/titleFight are not part of this acceptance criteria,
    //   but are required by createMarket() on-chain.
    const scheduledAtIso = new Date(startMs).toISOString();
    const lockBeforeMinutes = Math.max(0, Math.floor((startMs - Date.now()) / 60000));

    setTxStatus({ hash: null, status: 'signing', error: null });

    try {
      await createMarket({
        matchId,
        fighterA,
        fighterB,
        // Required by contract call; using placeholders until the acceptance criteria expands.
        weightClass: 'Lightweight',
        venue: 'TBA',
        titleFight: false,
        scheduledAt: scheduledAtIso,
        minBetXlm: 1,
        maxBetXlm: 100,
        feeBps: feeBps,
        lockBeforeMinutes,
      });

      setTxStatus({ hash: null, status: 'success', error: null });
      // useCreateMarket() already redirects to the detail page after success.
    } catch (err: any) {
      setTxStatus({ hash: null, status: 'error', error: err?.message ?? String(err) });
    }
  };

  // Show loading or auth error message while redirecting
  if (isLoading || !isAuthorized) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="mt-12 text-center space-y-4">
          {!connectedAddress ? (
            <>
              <h1 className="text-3xl font-bold text-white mb-4">Wallet Connection Required</h1>
              <p className="text-gray-300 mb-6">
                You need to connect your wallet to create a boxing market. Please connect a wallet and try again.
              </p>
              <p className="text-sm text-gray-400">Redirecting to home page...</p>
            </>
          ) : !isAdmin ? (
            <>
              <h1 className="text-3xl font-bold text-white mb-4">Admin Access Required</h1>
              <p className="text-gray-300 mb-6">
                Only authorized administrators can create boxing markets. Please contact the team if you believe this is an error.
              </p>
              <p className="text-sm text-gray-400">Redirecting to home page...</p>
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">Create Boxing Market</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Match ID</label>
          <input
            name="matchId"
            type="text"
            required
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Fighter A</label>
            <input
              name="fighterA"
              type="text"
              required
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Fighter B</label>
            <input
              name="fighterB"
              type="text"
              required
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Start Time</label>
          <input
            name="startTime"
            type="datetime-local"
            required
            min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">End Time</label>
          <input
            name="endTime"
            type="datetime-local"
            required
            min={new Date(Date.now() + 120_000).toISOString().slice(0, 16)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Fee BPS (optional)</label>
          <input
            name="feeBps"
            type="number"
            min="0"
            step="1"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded"
            placeholder="e.g. 50 for 0.50%"
          />
        </div>

        <button
          type="submit"
          disabled={['signing', 'broadcasting', 'confirming'].includes(txStatus.status)}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded font-semibold"
        >
          {['signing', 'broadcasting', 'confirming'].includes(txStatus.status)
            ? 'Creating...'
            : 'Create Market'}
        </button>
      </form>
      <TxStatusToast
        txStatus={txStatus}
        onDismiss={() => setTxStatus({ hash: null, status: 'idle', error: null })}
      />
    </div>
  );
}
