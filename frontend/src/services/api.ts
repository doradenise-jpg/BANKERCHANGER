// ============================================================
// BANKERCHANGER — API Service
// Typed wrappers around the backend REST endpoints.
// Base URL is set from NEXT_PUBLIC_API_URL env variable.
// Contributors: implement every function marked TODO.
// ============================================================

import type {
  Bet,
  Market,
  MarketStats,
  Portfolio,
  UserStreak,
  Achievement,
  UserAchievement,
  Leaderboard,
  ReferralSummary,
  ReferralPayoutResult,
  UserNotification,
} from '../types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class NotFoundError extends Error {
  constructor(message = 'Not found') { super(message); this.name = 'NotFoundError'; }
}

export class NetworkError extends Error {
  constructor(message = 'Network error') { super(message); this.name = 'NetworkError'; }
}

export class TimeoutError extends Error {
  constructor(message = 'Request timeout (10s)') { super(message); this.name = 'TimeoutError'; }
}

const TIMEOUT_MS = 10000; // 10 seconds

type ApiOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
};

async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const method = options.method ?? 'GET';
  const init: RequestInit = { method, signal: controller.signal };
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new TimeoutError();
    }
    throw new NetworkError((e as Error).message);
  } finally {
    clearTimeout(timeoutId);
  }
  if (res.status === 404) throw new NotFoundError();
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new NetworkError(`Unexpected response: ${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

export interface MarketFilters {
  status?: string;
  weight_class?: string;
  search?: string;
  sort?: 'date_asc' | 'date_desc' | 'pool_desc';
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface MarketListResponse {
  markets: Market[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Calls GET /api/markets with optional filters and pagination.
 * Returns typed MarketListResponse.
 * Throws NetworkError if the request fails.
 */
export async function fetchMarkets(
  filters?: MarketFilters,
  pagination?: PaginationParams,
): Promise<MarketListResponse> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.weight_class) params.set('weight_class', filters.weight_class);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.sort) params.set('sort', filters.sort);
  if (pagination?.page) params.set('page', pagination.page.toString());
  if (pagination?.limit) params.set('limit', pagination.limit.toString());
  const qs = params.toString();
  return apiFetch<MarketListResponse>(`/api/markets${qs ? `?${qs}` : ''}`);
}

/**
 * Calls GET /api/markets/:market_id.
 * Returns the Market including live odds.
 * Throws NotFoundError on 404.
 */
export async function fetchMarketById(market_id: string): Promise<Market> {
  return apiFetch<Market>(`/api/markets/${market_id}`);
}

/**
 * Calls GET /api/markets/:market_id/bets.
 * Returns all bets for the market.
 */
export async function fetchBetsByMarket(market_id: string): Promise<Bet[]> {
  return apiFetch<Bet[]>(`/api/markets/${market_id}/bets`);
}

/**
 * Calls GET /api/portfolio/:address.
 * Returns the full Portfolio object.
 */
export async function fetchPortfolio(address: string): Promise<Portfolio> {
  return apiFetch<Portfolio>(`/api/portfolio/${address}`);
}

/**
 * Calls GET /api/markets/:market_id/stats.
 * Returns aggregate MarketStats.
 */
export async function fetchMarketStats(market_id: string): Promise<MarketStats> {
  return apiFetch<MarketStats>(`/api/markets/${market_id}/stats`);
}

// ---------------------------------------------------------------------------
// Engagement — User Experience & Social
// ---------------------------------------------------------------------------

/**
 * Calls GET /api/engagement/streak/:address.
 * Returns a user's prediction streak.
 */
export async function fetchUserStreak(address: string): Promise<UserStreak> {
  return apiFetch<UserStreak>(`/api/engagement/streak/${address}`);
}

/**
 * Calls POST /api/engagement/predictions.
 * Records a prediction and returns the updated streak + earned achievements.
 */
export async function recordPrediction(address: string): Promise<{
  streak: UserStreak;
  earnedAchievements: string[];
}> {
  return apiFetch<{ streak: UserStreak; earnedAchievements: string[] }>(
    '/api/engagement/predictions',
    { method: 'POST', body: { address } },
  );
}

/**
 * Calls GET /api/engagement/achievements.
 * Returns the achievement badge catalogue.
 */
export async function fetchAchievements(): Promise<Achievement[]> {
  return apiFetch<Achievement[]>('/api/engagement/achievements');
}

/**
 * Calls GET /api/engagement/achievements/:address.
 * Returns the badges a user has earned.
 */
export async function fetchUserAchievements(address: string): Promise<UserAchievement[]> {
  return apiFetch<UserAchievement[]>(`/api/engagement/achievements/${address}`);
}

/**
 * Calls GET /api/engagement/leaderboard.
 * Returns the global engagement leaderboard.
 */
export async function fetchLeaderboard(limit = 50): Promise<Leaderboard> {
  return apiFetch<Leaderboard>(`/api/engagement/leaderboard?limit=${limit}`);
}

/**
 * Calls GET /api/engagement/referrals/:address.
 * Returns a referral summary for the address.
 */
export async function fetchReferralSummary(address: string): Promise<ReferralSummary> {
  return apiFetch<ReferralSummary>(`/api/engagement/referrals/${address}`);
}

/**
 * Calls POST /api/engagement/referrals/payout.
 * Calculates expected referral payouts for an amount.
 */
export async function calculateReferralPayout(
  address: string,
  amount: number,
): Promise<ReferralPayoutResult> {
  return apiFetch<ReferralPayoutResult>('/api/engagement/referrals/payout', {
    method: 'POST',
    body: { address, amount },
  });
}

/**
 * Calls GET /api/engagement/notifications/:address.
 * Returns the user's notifications.
 */
export async function fetchNotifications(address: string, limit = 50): Promise<UserNotification[]> {
  return apiFetch<UserNotification[]>(
    `/api/engagement/notifications/${address}?limit=${limit}`,
  );
}
