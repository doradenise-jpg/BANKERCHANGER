'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { getConnectedAddress } from '@/services/wallet';
import { TxStatusToast } from '@/components/ui/TxStatusToast';
import type { TxStatus } from '@/types';
import { TX_PENDING_STATES } from '@/types';
import { useCreateMarket } from '@/hooks/useCreateMarket';
import { createMarketSchema, type CreateMarketFormData } from '@/schemas/createMarket.schema';

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

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateMarketFormData>({
    resolver: zodResolver(createMarketSchema),
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  // Auth guard: redirect if wallet not connected or not an admin
  useEffect(() => {
    if (!connectedAddress) {
      const timer = setTimeout(() => {
        router.push('/');
      }, 2000);
      return () => clearTimeout(timer);
    }

    if (!isAdmin) {
      const timer = setTimeout(() => {
        router.push('/');
      }, 2000);
      return () => clearTimeout(timer);
    }

    setIsAuthorized(true);
    setIsLoading(false);
  }, [connectedAddress, isAdmin, router]);

  const onSubmit = async (values: CreateMarketFormData) => {
    const startMs = new Date(values.startTime).getTime();
    const scheduledAtIso = new Date(startMs).toISOString();
    const lockBeforeMinutes = Math.max(0, Math.floor((startMs - Date.now()) / 60000));

    setTxStatus({ hash: null, status: 'signing', error: null });

    try {
      await createMarket({
        matchId: values.matchId,
        fighterA: values.fighterA,
        fighterB: values.fighterB,
        weightClass: values.weightClass || 'Lightweight',
        venue: values.venue || 'TBA',
        titleFight: values.titleFight || false,
        scheduledAt: scheduledAtIso,
        minBetXlm: values.minBetXlm || 1,
        maxBetXlm: values.maxBetXlm || 100,
        feeBps: values.feeBps || 0,
        lockBeforeMinutes,
      });

      setTxStatus({ hash: null, status: 'success', error: null });
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
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div>
          <label className="block text-sm font-medium mb-1">Match ID</label>
          <input
            {...register('matchId')}
            type="text"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
          />
          {errors.matchId && (
            <p role="alert" className="text-red-400 text-xs mt-1">
              {errors.matchId.message}
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Fighter A</label>
            <input
              {...register('fighterA')}
              type="text"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
            />
            {errors.fighterA && (
              <p role="alert" className="text-red-400 text-xs mt-1">
                {errors.fighterA.message}
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Fighter B</label>
            <input
              {...register('fighterB')}
              type="text"
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
            />
            {errors.fighterB && (
              <p role="alert" className="text-red-400 text-xs mt-1">
                {errors.fighterB.message}
              </p>
            )}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Start Time</label>
          <input
            {...register('startTime')}
            type="datetime-local"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
          />
          {errors.startTime && (
            <p role="alert" className="text-red-400 text-xs mt-1">
              {errors.startTime.message}
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">End Time</label>
          <input
            {...register('endTime')}
            type="datetime-local"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
          />
          {errors.endTime && (
            <p role="alert" className="text-red-400 text-xs mt-1">
              {errors.endTime.message}
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Fee BPS (optional)</label>
          <input
            {...register('feeBps')}
            type="number"
            min="0"
            step="1"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white"
            placeholder="e.g. 50 for 0.50%"
          />
          {errors.feeBps && (
            <p role="alert" className="text-red-400 text-xs mt-1">
              {errors.feeBps.message}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={(TX_PENDING_STATES as readonly string[]).includes(txStatus.status)}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed rounded font-semibold flex items-center justify-center gap-2"
        >
          {(TX_PENDING_STATES as readonly string[]).includes(txStatus.status) && (
            <svg
              className="animate-spin h-4 w-4 text-white"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          )}
          {(TX_PENDING_STATES as readonly string[]).includes(txStatus.status)
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
