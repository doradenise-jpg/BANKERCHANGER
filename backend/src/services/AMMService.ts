import { pool } from "../config/db";
import { redis } from "../services/cache.service";
import { logger } from "../utils/logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LiquidityPool {
  id: string;
  market_id: string;
  tier: number;
  outcome: "fighter_a" | "fighter_b" | "draw";
  token_balance: number;
  stellar_balance: number;
  total_shares: number;
  fee_percent: number;
  created_at: string;
  updated_at: string;
}

export interface OddsCalculation {
  market_id: string;
  tier: number;
  fighter_a_odds: number;
  fighter_b_odds: number;
  draw_odds: number;
  implied_probabilities: {
    fighter_a: number;
    fighter_b: number;
    draw: number;
  };
  liquidity_depth: number;
  calculated_at: string;
}

export interface BetExecution {
  market_id: string;
  tier: number;
  bettor: string;
  outcome: "fighter_a" | "fighter_b" | "draw";
  amount: number;
  expected_odds: number;
  slippage_tolerance: number;
  actual_odds: number;
  tokens_received: number;
  fee_deducted: number;
}

export interface OracleConsensus {
  market_id: string;
  report_count: number;
  required_reports: number;
  consensus_reached: boolean;
  outcome: string | null;
  reports: OracleReport[];
}

export interface OracleReport {
  oracle_id: string;
  market_id: string;
  outcome: string;
  confidence: number;
  reported_at: string;
  signature: string;
}

// ─── Pool Management ─────────────────────────────────────────────────────────

export async function createLiquidityPool(params: {
  marketId: string;
  tier: number;
  initialLiquidity: number;
  feePercent?: number;
}): Promise<LiquidityPool> {
  const id = `pool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const feePercent = params.feePercent ?? 0.02;

  const outcomes: Array<"fighter_a" | "fighter_b" | "draw"> = ["fighter_a", "fighter_b", "draw"];
  const pools: LiquidityPool[] = [];

  for (const outcome of outcomes) {
    const poolId = `${id}_${outcome}`;
    await pool.query(
      `INSERT INTO liquidity_pools
        (id, market_id, tier, outcome, token_balance, stellar_balance,
         total_shares, fee_percent, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
      [
        poolId,
        params.marketId,
        params.tier,
        outcome,
        params.initialLiquidity / 3,
        params.initialLiquidity / 3,
        params.initialLiquidity / 3,
        feePercent,
      ],
    );

    pools.push({
      id: poolId,
      market_id: params.marketId,
      tier: params.tier,
      outcome,
      token_balance: params.initialLiquidity / 3,
      stellar_balance: params.initialLiquidity / 3,
      total_shares: params.initialLiquidity / 3,
      fee_percent: feePercent,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  logger.info({ market_id: params.marketId, tier: params.tier }, "Created liquidity pools");
  return pools[0];
}

export async function getLiquidityPool(
  marketId: string,
  tier: number,
  outcome: string,
): Promise<LiquidityPool | null> {
  const result = await pool.query(
    `SELECT * FROM liquidity_pools
     WHERE market_id = $1 AND tier = $2 AND outcome = $3`,
    [marketId, tier, outcome],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    id: row.id,
    market_id: row.market_id,
    tier: row.tier,
    outcome: row.outcome,
    token_balance: parseFloat(row.token_balance),
    stellar_balance: parseFloat(row.stellar_balance),
    total_shares: parseFloat(row.total_shares),
    fee_percent: parseFloat(row.fee_percent),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── Odds Calculation ────────────────────────────────────────────────────────

export async function calculateOdds(
  marketId: string,
  tier: number,
): Promise<OddsCalculation> {
  const pools = await pool.query(
    `SELECT * FROM liquidity_pools
     WHERE market_id = $1 AND tier = $2`,
    [marketId, tier],
  );

  const totalLiquidity = pools.rows.reduce(
    (sum, row) => sum + parseFloat(row.stellar_balance),
    0,
  );

  // Calculate implied probabilities using liquidity-weighted formula
  const weights: Record<string, number> = {};
  for (const row of pools.rows) {
    weights[row.outcome] = parseFloat(row.stellar_balance);
  }

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);

  const impliedProbabilities = {
    fighter_a: totalWeight > 0 ? (weights["fighter_a"] || 0) / totalWeight : 1 / 3,
    fighter_b: totalWeight > 0 ? (weights["fighter_b"] || 0) / totalWeight : 1 / 3,
    draw: totalWeight > 0 ? (weights["draw"] || 0) / totalWeight : 1 / 3,
  };

  // Convert to decimal odds (1 / probability)
  const fighterAOdds = impliedProbabilities.fighter_a > 0
    ? Math.round((1 / impliedProbabilities.fighter_a) * 100) / 100
    : 3.0;
  const fighterBOdds = impliedProbabilities.fighter_b > 0
    ? Math.round((1 / impliedProbabilities.fighter_b) * 100) / 100
    : 3.0;
  const drawOdds = impliedProbabilities.draw > 0
    ? Math.round((1 / impliedProbabilities.draw) * 100) / 100
    : 3.0;

  const odds: OddsCalculation = {
    market_id: marketId,
    tier,
    fighter_a_odds: fighterAOdds,
    fighter_b_odds: fighterBOdds,
    draw_odds: drawOdds,
    implied_probabilities: impliedProbabilities,
    liquidity_depth: totalLiquidity,
    calculated_at: new Date().toISOString(),
  };

  // Cache odds for 30 seconds
  const cacheKey = `odds:${marketId}:tier${tier}`;
  await redis.setex(cacheKey, 30, JSON.stringify(odds));

  return odds;
}

// ─── Slippage Check ──────────────────────────────────────────────────────────

export function checkSlippage(
  expectedOdds: number,
  actualOdds: number,
  tolerance: number,
): { accepted: boolean; slippagePercent: number } {
  const slippagePercent = Math.abs(actualOdds - expectedOdds) / expectedOdds;
  return {
    accepted: slippagePercent <= tolerance,
    slippagePercent: Math.round(slippagePercent * 10000) / 100,
  };
}

// ─── Bet Execution ───────────────────────────────────────────────────────────

export async function executeBet(params: {
  marketId: string;
  tier: number;
  bettor: string;
  outcome: "fighter_a" | "fighter_b" | "draw";
  amount: number;
  slippageTolerance: number;
}): Promise<BetExecution> {
  const poolData = await getLiquidityPool(params.marketId, params.tier, params.outcome);
  if (!poolData) {
    throw new Error(`No liquidity pool found for ${params.outcome} at tier ${params.tier}`);
  }

  // Calculate current odds
  const odds = await calculateOdds(params.marketId, params.tier);
  const currentOdds = odds[`${params.outcome}_odds` as keyof typeof odds] as number;

  // Check slippage
  const slippage = checkSlippage(currentOdds, currentOdds, params.slippageTolerance);
  if (!slippage.accepted) {
    throw new Error(`Slippage ${slippage.slippagePercent}% exceeds tolerance ${params.slippageTolerance * 100}%`);
  }

  // Calculate tokens and fee
  const feePercent = poolData.fee_percent;
  const feeDeducted = params.amount * feePercent;
  const netAmount = params.amount - feeDeducted;
  const tokensReceived = netAmount / currentOdds;

  // Update pool
  await pool.query(
    `UPDATE liquidity_pools
     SET stellar_balance = stellar_balance + $1,
         token_balance = token_balance - $2,
         total_shares = total_shares + $2,
         updated_at = NOW()
     WHERE id = $3`,
    [netAmount, tokensReceived, poolData.id],
  );

  // Record bet
  await pool.query(
    `INSERT INTO amm_bets
      (market_id, tier, bettor, outcome, amount, expected_odds,
       slippage_tolerance, actual_odds, tokens_received, fee_deducted, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
    [
      params.marketId,
      params.tier,
      params.bettor,
      params.outcome,
      params.amount,
      currentOdds,
      params.slippageTolerance,
      currentOdds,
      tokensReceived,
      feeDeducted,
    ],
  );

  // Emit event for real-time updates
  await redis.publish("market_events", JSON.stringify({
    type: "bet_executed",
    market_id: params.marketId,
    tier: params.tier,
    bettor: params.bettor,
    outcome: params.outcome,
    amount: params.amount,
    odds: currentOdds,
    tokens_received: tokensReceived,
    timestamp: new Date().toISOString(),
  }));

  return {
    market_id: params.marketId,
    tier: params.tier,
    bettor: params.bettor,
    outcome: params.outcome,
    amount: params.amount,
    expected_odds: currentOdds,
    slippage_tolerance: params.slippageTolerance,
    actual_odds: currentOdds,
    tokens_received: tokensReceived,
    fee_deducted: feeDeducted,
  };
}

// ─── Oracle Consensus ────────────────────────────────────────────────────────

const REQUIRED_REPORTS = 2;
const CONSENSUS_THRESHOLD = 0.67;

export async function verifyOracleConsensus(
  marketId: string,
): Promise<OracleConsensus> {
  const reportsResult = await pool.query(
    `SELECT * FROM oracle_reports
     WHERE market_id = $1
     ORDER BY reported_at DESC`,
    [marketId],
  );

  const reports: OracleReport[] = reportsResult.rows.map((row) => ({
    oracle_id: row.oracle_id,
    market_id: row.market_id,
    outcome: row.outcome,
    confidence: parseFloat(row.confidence),
    reported_at: row.reported_at,
    signature: row.signature,
  }));

  if (reports.length < REQUIRED_REPORTS) {
    return {
      market_id: marketId,
      report_count: reports.length,
      required_reports: REQUIRED_REPORTS,
      consensus_reached: false,
      outcome: null,
      reports,
    };
  }

  // Check for 2-of-3 consensus
  const outcomeCounts: Record<string, number> = {};
  for (const report of reports) {
    if (report.confidence >= 0.8) {
      outcomeCounts[report.outcome] = (outcomeCounts[report.outcome] || 0) + 1;
    }
  }

  let consensusOutcome: string | null = null;
  let consensusReached = false;

  for (const [outcome, count] of Object.entries(outcomeCounts)) {
    if (count >= REQUIRED_REPORTS) {
      consensusOutcome = outcome;
      consensusReached = true;
      break;
    }
  }

  return {
    market_id: marketId,
    report_count: reports.length,
    required_reports: REQUIRED_REPORTS,
    consensus_reached: consensusReached,
    outcome: consensusOutcome,
    reports,
  };
}

export async function submitOracleReport(params: {
  oracleId: string;
  marketId: string;
  outcome: string;
  confidence: number;
  signature: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO oracle_reports
      (oracle_id, market_id, outcome, confidence, signature, reported_at)
     VALUES ($1,$2,$3,$4,$5,NOW())`,
    [params.oracleId, params.marketId, params.outcome, params.confidence, params.signature],
  );

  // Check if consensus is reached
  const consensus = await verifyOracleConsensus(params.marketId);
  if (consensus.consensus_reached) {
    logger.info(
      { market_id: params.marketId, outcome: consensus.outcome },
      "Oracle consensus reached",
    );

    await redis.publish("market_events", JSON.stringify({
      type: "oracle_consensus",
      market_id: params.marketId,
      outcome: consensus.outcome,
      report_count: consensus.report_count,
      timestamp: new Date().toISOString(),
    }));
  }
}
