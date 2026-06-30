// ============================================================
// BOXMEOUT — usePortfolio Hook
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import type { Portfolio, TxStatus } from '../types';
import { useWallet } from './useWallet';
import { fetchPortfolio } from '../services/api';
import { submitClaim, submitRefund } from '../services/wallet';

export interface UsePortfolioResult {
  portfolio: Portfolio | null;
  bets: any[];
  isLoading: boolean;
  error: Error | null;
  claimTxStatus: TxStatus;
  page: number;
  limit: number;
  total: number;
  loadNextPage: () => Promise<void>;
  /** Submits claim_winnings for a market contract. Refreshes portfolio after. */
  claimWinnings: (market_contract_address: string) => Promise<void>;
  /** Submits claim_refund for a cancelled market. Refreshes portfolio after. */
  claimRefund: (market_contract_address: string) => Promise<void>;
}

/**
 * Fetches the portfolio for the currently connected wallet.
 * Returns null portfolio if no wallet is connected.
 * Supports paginated bets loading with loadNextPage().
 */
export function usePortfolio(): UsePortfolioResult {
  const { address } = useWallet();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [bets, setBets] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [claimTxStatus, setClaimTxStatus] = useState<TxStatus>({
    hash: null,
    status: 'idle',
    error: null,
  });

  const load = useCallback(async () => {
    if (!address) { 
      setPortfolio(null);
      setBets([]);
      setTotal(0);
      return; 
    }
    setIsLoading(true);
    setError(null);
    try {
      setPortfolio(await fetchPortfolio(address));
      // Load first page of bets
      const response = await fetch(`/api/bets/${address}?page=1&limit=${limit}`);
      const data = await response.json();
      setBets(data.bets);
      setTotal(data.total);
      setPage(1);
    } catch (e: any) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
    }
  }, [address, limit]);

  useEffect(() => { load(); }, [load]);

  const loadNextPage = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);
    try {
      const nextPage = page + 1;
      const response = await fetch(`/api/bets/${address}?page=${nextPage}&limit=${limit}`);
      const data = await response.json();
      setBets([...bets, ...data.bets]);
      setPage(nextPage);
    } catch (e: any) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
    }
  }, [address, page, limit, bets]);

  // Refresh when useClaimWinnings hook fires a successful claim
  useEffect(() => {
    const handler = () => { load(); };
    window.addEventListener('boxmeout:claim_success', handler);
    return () => window.removeEventListener('boxmeout:claim_success', handler);
  }, [load]);

  const runClaim = useCallback(async (fn: () => Promise<string>) => {
    setClaimTxStatus({ hash: null, status: 'signing', error: null });
    try {
      const hash = await fn();
      setClaimTxStatus({ hash, status: 'success', error: null });
      await load();
    } catch (e: any) {
      setClaimTxStatus({ hash: null, status: 'error', error: e?.message ?? String(e) });
    }
  }, [load]);

  const claimWinnings = useCallback(
    (market_contract_address: string) =>
      runClaim(() => submitClaim(market_contract_address)),
    [runClaim],
  );

  const claimRefund = useCallback(
    (market_contract_address: string) =>
      runClaim(() => submitRefund(market_contract_address)),
    [runClaim],
  );

  return { 
    portfolio, 
    bets,
    isLoading, 
    error, 
    claimTxStatus, 
    page,
    limit,
    total,
    loadNextPage,
    claimWinnings, 
    claimRefund 
  };
}
