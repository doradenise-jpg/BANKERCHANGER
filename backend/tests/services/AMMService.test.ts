import {
  checkSlippage,
  verifyOracleConsensus,
} from "../../src/services/AMMService";
import { pool } from "../../src/config/db";

jest.mock("../../src/config/db", () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock("../../src/services/cache.service", () => ({
  redis: {
    setex: jest.fn(),
    publish: jest.fn(),
  },
}));

jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockPool = pool as jest.Mocked<typeof pool>;

describe("AMMService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("checkSlippage", () => {
    it("accepts bet within slippage tolerance", () => {
      const result = checkSlippage(2.0, 2.05, 0.05);
      expect(result.accepted).toBe(true);
      expect(result.slippagePercent).toBe(2.5);
    });

    it("rejects bet exceeding slippage tolerance", () => {
      const result = checkSlippage(2.0, 2.5, 0.05);
      expect(result.accepted).toBe(false);
      expect(result.slippagePercent).toBe(25);
    });

    it("accepts bet at exact tolerance boundary", () => {
      const result = checkSlippage(2.0, 2.09, 0.05);
      expect(result.accepted).toBe(true);
      expect(result.slippagePercent).toBe(4.5);
    });
  });

  describe("verifyOracleConsensus", () => {
    it("returns false when not enough reports", async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            oracle_id: "oracle1",
            market_id: "market1",
            outcome: "fighter_a",
            confidence: "0.9",
            reported_at: new Date().toISOString(),
            signature: "sig1",
          },
        ],
      } as any);

      const result = await verifyOracleConsensus("market1");
      expect(result.consensus_reached).toBe(false);
      expect(result.report_count).toBe(1);
    });

    it("returns true when 2-of-3 consensus reached", async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValue({
        rows: [
          {
            oracle_id: "oracle1",
            market_id: "market1",
            outcome: "fighter_a",
            confidence: "0.9",
            reported_at: now,
            signature: "sig1",
          },
          {
            oracle_id: "oracle2",
            market_id: "market1",
            outcome: "fighter_a",
            confidence: "0.85",
            reported_at: now,
            signature: "sig2",
          },
          {
            oracle_id: "oracle3",
            market_id: "market1",
            outcome: "fighter_b",
            confidence: "0.8",
            reported_at: now,
            signature: "sig3",
          },
        ],
      } as any);

      const result = await verifyOracleConsensus("market1");
      expect(result.consensus_reached).toBe(true);
      expect(result.outcome).toBe("fighter_a");
      expect(result.report_count).toBe(3);
    });

    it("returns false when no consensus on outcome", async () => {
      const now = new Date().toISOString();
      mockPool.query.mockResolvedValue({
        rows: [
          {
            oracle_id: "oracle1",
            market_id: "market1",
            outcome: "fighter_a",
            confidence: "0.9",
            reported_at: now,
            signature: "sig1",
          },
          {
            oracle_id: "oracle2",
            market_id: "market1",
            outcome: "fighter_b",
            confidence: "0.85",
            reported_at: now,
            signature: "sig2",
          },
          {
            oracle_id: "oracle3",
            market_id: "market1",
            outcome: "draw",
            confidence: "0.8",
            reported_at: now,
            signature: "sig3",
          },
        ],
      } as any);

      const result = await verifyOracleConsensus("market1");
      expect(result.consensus_reached).toBe(false);
      expect(result.outcome).toBeNull();
    });
  });
});
