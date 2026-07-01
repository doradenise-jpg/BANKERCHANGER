import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { Keypair } from '@stellar/stellar-sdk';
import * as OracleService from '../../src/oracle/OracleService';
import * as StellarService from '../../src/services/StellarService';
import { pool } from '../../src/config/db';

jest.mock('../../src/services/StellarService');
jest.mock('../../src/config/db');

const mockRedisIncr = jest.fn().mockResolvedValue(1);
const mockRedisExpire = jest.fn().mockResolvedValue(1);
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisSet = jest.fn().mockResolvedValue('OK');

jest.mock('../../src/services/cache.service', () => {
  const original = jest.requireActual('../../src/services/cache.service');
  return {
    ...original,
    cacheGet: jest.fn().mockResolvedValue(undefined),
    cacheSet: jest.fn().mockResolvedValue(undefined),
    redis: {
      incr: jest.fn((...args: any[]) => mockRedisIncr(...args)),
      expire: jest.fn((...args: any[]) => mockRedisExpire(...args)),
      get: jest.fn((...args: any[]) => mockRedisGet(...args)),
      del: jest.fn((...args: any[]) => mockRedisDel(...args)),
      set: jest.fn((...args: any[]) => mockRedisSet(...args)),
    },
  };
});

// Mock global fetch for external API calls
const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

describe('OracleService', () => {
  const mockKeypair = Keypair.random();
  const mockOracleAddress = mockKeypair.publicKey();
  const mockMatchId = 'match-123';
  const mockOutcome: OracleService.FightOutcome = 'fighter_a';
  const mockTxHash = 'tx-hash-123';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ORACLE_PRIVATE_KEY = mockKeypair.secret();
    process.env.ADMIN_PRIVATE_KEY = Keypair.random().secret();
    process.env.ORACLE_WHITELIST = mockOracleAddress;
  });

  afterEach(() => {
    delete process.env.ORACLE_PRIVATE_KEY;
    delete process.env.ADMIN_PRIVATE_KEY;
    delete process.env.ORACLE_WHITELIST;
  });

  describe('submitFightResult', () => {
    it('should submit fight result successfully', async () => {
      const mockInsertResult = {
        rowCount: 1,
        rows: [
          {
            id: 1,
            match_id: mockMatchId,
            oracle_address: mockOracleAddress,
            outcome: mockOutcome,
            reported_at: new Date(),
            signature: 'sig-123',
            accepted: false,
            tx_hash: null,
            created_at: new Date(),
          },
        ],
      };

      const mockMarketResult = {
        rowCount: 1,
        rows: [{ contract_address: 'contract-123' }],
      };

      const mockUpdateResult = {
        rowCount: 1,
        rows: [
          {
            id: 1,
            match_id: mockMatchId,
            oracle_address: mockOracleAddress,
            outcome: mockOutcome,
            reported_at: new Date(),
            signature: 'sig-123',
            accepted: true,
            tx_hash: mockTxHash,
            created_at: new Date(),
          },
        ],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce(mockInsertResult)
        .mockResolvedValueOnce(mockMarketResult)
        .mockResolvedValueOnce(mockUpdateResult);

      (StellarService.invokeContract as jest.Mock).mockResolvedValue(mockTxHash);

      const result = await OracleService.submitFightResult(mockMatchId, mockOutcome);

      expect(result.tx_hash).toBe(mockTxHash);
      expect(result.accepted).toBe(true);
      expect(StellarService.invokeContract).toHaveBeenCalledWith(
        'contract-123',
        'resolve_market',
        expect.any(Array),
      );
    });

    it('should throw error if market not found', async () => {
      const mockInsertResult = {
        rowCount: 1,
        rows: [
          {
            id: 1,
            match_id: mockMatchId,
            oracle_address: mockOracleAddress,
            outcome: mockOutcome,
            reported_at: new Date(),
            signature: 'sig-123',
            accepted: false,
            tx_hash: null,
            created_at: new Date(),
          },
        ],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce(mockInsertResult)
        .mockResolvedValueOnce({ rowCount: 0, rows: [] });

      await expect(OracleService.submitFightResult(mockMatchId, mockOutcome)).rejects.toThrow(
        'Market not found',
      );
    });

    it('should throw error if ORACLE_PRIVATE_KEY not set', async () => {
      delete process.env.ORACLE_PRIVATE_KEY;

      await expect(OracleService.submitFightResult(mockMatchId, mockOutcome)).rejects.toThrow(
        'ORACLE_PRIVATE_KEY env var is required',
      );
    });
  });

  describe('verifyOracleReport', () => {
    it('should verify valid oracle report', async () => {
      const keypair = Keypair.fromSecret(process.env.ORACLE_PRIVATE_KEY!);
      const outcomeIndex = 0; // fighter_a
      const reportedAt = new Date();
      const tsBuf = Buffer.alloc(8);
      tsBuf.writeBigInt64BE(BigInt(reportedAt.getTime()));

      const matchIdBytes = Buffer.from(mockMatchId, 'utf8');
      const xdrLen = Buffer.alloc(4);
      xdrLen.writeUInt32BE(matchIdBytes.length, 0);
      const message = Buffer.concat([
        xdrLen,
        matchIdBytes,
        Buffer.from([outcomeIndex]),
        tsBuf,
      ]);

      const signature = Buffer.from(keypair.sign(message)).toString('hex');

      const report = {
        match_id: mockMatchId,
        oracle_address: keypair.publicKey(),
        outcome: mockOutcome,
        reported_at: reportedAt,
        signature,
        accepted: true,
        tx_hash: mockTxHash,
        id: 1,
        created_at: new Date(),
      };

      const isValid = await OracleService.verifyOracleReport(report);
      expect(isValid).toBe(true);
    });

    it('should reject invalid signature', async () => {
      const report = {
        match_id: mockMatchId,
        oracle_address: mockOracleAddress,
        outcome: mockOutcome,
        reported_at: new Date(),
        signature: 'invalid-signature-hex',
        accepted: true,
        tx_hash: mockTxHash,
        id: 1,
        created_at: new Date(),
      };

      const isValid = await OracleService.verifyOracleReport(report);
      expect(isValid).toBe(false);
    });

    it('should reject oracle not in whitelist', async () => {
      delete process.env.ORACLE_WHITELIST;

      const keypair = Keypair.random();
      const outcomeIndex = 0;
      const reportedAt = new Date();
      const tsBuf = Buffer.alloc(8);
      tsBuf.writeBigInt64BE(BigInt(reportedAt.getTime()));
      const matchIdBytes = Buffer.from(mockMatchId, 'utf8');
      const xdrLen = Buffer.alloc(4);
      xdrLen.writeUInt32BE(matchIdBytes.length, 0);
      const message = Buffer.concat([
        xdrLen,
        matchIdBytes,
        Buffer.from([outcomeIndex]),
        tsBuf,
      ]);

      const signature = Buffer.from(keypair.sign(message)).toString('hex');

      const report = {
        match_id: mockMatchId,
        oracle_address: keypair.publicKey(),
        outcome: mockOutcome,
        reported_at: reportedAt,
        signature,
        accepted: true,
        tx_hash: mockTxHash,
        id: 1,
        created_at: new Date(),
      };

      const isValid = await OracleService.verifyOracleReport(report);
      expect(isValid).toBe(false);
    });
  });

  describe('raiseDispute', () => {
    it('should raise dispute successfully', async () => {
      const adminKeypair = Keypair.fromSecret(process.env.ADMIN_PRIVATE_KEY!);
      const adminSignature = 'admin-sig-123';

      const mockMarketResult = {
        rowCount: 1,
        rows: [{ contract_address: 'contract-123' }],
      };

      const mockInsertResult = {
        rowCount: 1,
        rows: [
          {
            id: 1,
            match_id: mockMatchId,
            oracle_address: 'admin',
            outcome: mockOutcome,
            reported_at: new Date(),
            signature: adminSignature,
            accepted: true,
            tx_hash: mockTxHash,
          },
        ],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce(mockMarketResult)
        .mockResolvedValueOnce(mockInsertResult);

      (StellarService.invokeContract as jest.Mock).mockResolvedValue(mockTxHash);

      const result = await OracleService.raiseDispute(mockMatchId, mockOutcome, adminSignature);

      expect(result).toBe(mockTxHash);
      expect(StellarService.invokeContract).toHaveBeenCalledWith(
        'contract-123',
        'dispute_market',
        expect.any(Array),
      );
    });

    it('should throw error if market not found', async () => {
      (pool.query as jest.Mock).mockResolvedValueOnce({ rowCount: 0, rows: [] });

      await expect(
        OracleService.raiseDispute(mockMatchId, mockOutcome, 'sig-123'),
      ).rejects.toThrow('Market not found');
    });
  });

  describe('pollFightResults', () => {
    beforeEach(() => {
      process.env.BOXING_API_URL = 'http://mock-boxing-api';
      process.env.BOXING_API_KEY = 'mock-key';
    });

    afterEach(() => {
      delete process.env.BOXING_API_URL;
      delete process.env.BOXING_API_KEY;
    });

    it('should process locked markets and submit results', async () => {
      const mockMarkets = {
        rowCount: 1,
        rows: [{ market_id: 'market-123', match_id: mockMatchId }],
      };
      const mockInsertResult = {
        rowCount: 1,
        rows: [{ id: 1, match_id: mockMatchId, oracle_address: mockOracleAddress, outcome: mockOutcome, reported_at: new Date(), signature: 'sig-123', accepted: false, tx_hash: null, created_at: new Date() }],
      };
      const mockSelectResult = {
        rowCount: 1,
        rows: [{ contract_address: 'contract-123' }],
      };
      const mockUpdateResult = {
        rowCount: 1,
        rows: [{ id: 1, match_id: mockMatchId, accepted: true, tx_hash: mockTxHash }],
      };

      // Mock pool.query for markets query, then insert, select, update
      (pool.query as jest.Mock)
        .mockResolvedValueOnce(mockMarkets)
        .mockResolvedValueOnce(mockInsertResult)
        .mockResolvedValueOnce(mockSelectResult)
        .mockResolvedValueOnce(mockUpdateResult);

      (StellarService.invokeContract as jest.Mock).mockResolvedValue(mockTxHash);

      // Mock fetch to return a confirmed fight result
      mockFetch.mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          fights: [
            { fight_id: mockMatchId, status: 'confirmed', result: mockOutcome },
          ],
        }),
      });

      const result = await OracleService.pollFightResults();

      expect(mockFetch).toHaveBeenCalled();
      expect(result.resolved).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('should skip markets with no confirmed result', async () => {
      const mockMarkets = {
        rowCount: 1,
        rows: [{ market_id: 'market-123', match_id: mockMatchId }],
      };

      (pool.query as jest.Mock).mockResolvedValueOnce(mockMarkets);

      // Mock fetch to return a pending (unconfirmed) fight
      mockFetch.mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({
          fights: [
            { fight_id: mockMatchId, status: 'pending' },
          ],
        }),
      });

      await OracleService.pollFightResults();

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle API failures gracefully', async () => {
      const mockMarkets = {
        rowCount: 1,
        rows: [{ market_id: 'market-123', match_id: mockMatchId }],
      };

      (pool.query as jest.Mock).mockResolvedValueOnce(mockMarkets);

      // Mock fetch to throw (simulate API down)
      mockFetch.mockRejectedValue(new Error('API error'));

      // Should not throw
      await expect(OracleService.pollFightResults()).resolves.not.toThrow();
    });

    it('should send alert after 3 consecutive failures', async () => {
      const mockMarkets = {
        rowCount: 1,
        rows: [{ market_id: 'market-123', match_id: mockMatchId }],
      };

      (pool.query as jest.Mock).mockResolvedValueOnce(mockMarkets);

      // Mock fetch to throw (simulate API down)
      mockFetch.mockRejectedValue(new Error('API error'));
      
      // Set up redis mocks for 3rd failure
      mockRedisIncr.mockResolvedValue(3);
      mockRedisGet.mockResolvedValue(null);

      // Set ALERT_WEBHOOK_URL
      process.env.ALERT_WEBHOOK_URL = 'http://mock-webhook';

      // Should call fetch to send alert
      await OracleService.pollFightResults();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://mock-webhook',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      // Clean up
      delete process.env.ALERT_WEBHOOK_URL;
    });
  });

  describe('runAutoResolutionJob — per-market isolation', () => {
    beforeEach(() => {
      process.env.BOXING_API_URL = 'http://mock-boxing-api';
      process.env.BOXING_API_KEY = 'mock-key';
    });

    afterEach(() => {
      delete process.env.BOXING_API_URL;
      delete process.env.BOXING_API_KEY;
    });

    it('processes market 2 even when market 1 throws', async () => {
      const market1 = { market_id: 'market-1', match_id: 'match-1' };
      const market2 = { market_id: 'market-2', match_id: 'match-2' };

      // First call: query markets list
      (pool.query as jest.Mock).mockResolvedValueOnce({
        rowCount: 2,
        rows: [market1, market2],
      });

      // market-1: fetch throws (e.g. RPC timeout)
      // market-2: fetch returns a confirmed result
      mockFetch
        .mockRejectedValueOnce(new Error('RPC timeout for market-1'))
        // market-2 primary fetch
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({
            fights: [{ fight_id: 'match-2', status: 'confirmed', result: 'fighter_b' }],
          }),
        })
        // market-2 alert webhook (if triggered) — not expected here but guard
        .mockResolvedValue({
          status: 200,
          ok: true,
          json: async () => ({ fights: [] }),
        });

      // market-2: submitFightResult DB calls — insert oracle_report, select contract, update report
      const market2InsertResult = {
        rowCount: 1,
        rows: [{ id: 2, match_id: 'match-2', oracle_address: mockOracleAddress, outcome: 'fighter_b', reported_at: new Date(), signature: 'sig-2', accepted: false, tx_hash: null, created_at: new Date() }],
      };
      const market2SelectResult = { rowCount: 1, rows: [{ contract_address: 'contract-2' }] };
      const market2UpdateResult = {
        rowCount: 1,
        rows: [{ id: 2, match_id: 'match-2', accepted: true, tx_hash: 'tx-market-2' }],
      };

      (pool.query as jest.Mock)
        .mockResolvedValueOnce(market2InsertResult)
        .mockResolvedValueOnce(market2SelectResult)
        .mockResolvedValueOnce(market2UpdateResult);

      (StellarService.invokeContract as jest.Mock).mockResolvedValue('tx-market-2');

      const stats = await OracleService.runAutoResolutionJob();

      // market-1 failed but market-2 resolved — batch was NOT aborted
      expect(stats.failed).toBe(1);
      expect(stats.resolved).toBe(1);
      expect(StellarService.invokeContract).toHaveBeenCalledWith(
        'contract-2',
        'resolve_market',
        expect.any(Array),
      );
    });

    it('logs market_id and error details for each failed market', async () => {
      const market1 = { market_id: 'market-err-1', match_id: 'match-err-1' };

      (pool.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1, rows: [market1] });
      mockFetch.mockRejectedValueOnce(new Error('contract error: insufficient funds'));

      const stats = await OracleService.runAutoResolutionJob();

      expect(stats.failed).toBe(1);
      expect(stats.resolved).toBe(0);
    });

    it('sends alert after 3 consecutive failures for the same market', async () => {
      const market1 = { market_id: 'market-alert', match_id: 'match-alert' };

      (pool.query as jest.Mock).mockResolvedValueOnce({ rowCount: 1, rows: [market1] });
      mockFetch.mockRejectedValueOnce(new Error('RPC timeout'));

      mockRedisIncr.mockResolvedValue(3);
      mockRedisGet.mockResolvedValue(null);

      process.env.ALERT_WEBHOOK_URL = 'http://mock-webhook';

      // second mockFetch call will be the alert webhook POST
      mockFetch.mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({}) });

      await OracleService.runAutoResolutionJob();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://mock-webhook',
        expect.objectContaining({ method: 'POST' }),
      );

      delete process.env.ALERT_WEBHOOK_URL;
    });
  });

  describe('getOraclePublicKey', () => {
    it('should return oracle public key', () => {
      const publicKey = OracleService.getOraclePublicKey();
      expect(publicKey).toBe(mockOracleAddress);
    });

    it('should throw error if ORACLE_PRIVATE_KEY not set', () => {
      delete process.env.ORACLE_PRIVATE_KEY;

      expect(() => OracleService.getOraclePublicKey()).toThrow(
        'ORACLE_PRIVATE_KEY env var is required',
      );
    });
  });
});
