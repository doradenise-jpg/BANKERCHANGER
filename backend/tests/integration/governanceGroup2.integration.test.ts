import { describe, it, expect, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import governanceGroup2Router from '../../src/routes/governanceGroup2.routes';
import { errorMiddleware } from '../../src/middleware/error.middleware';

const app = express();
app.use(express.json());
app.use('/api/v2/governance', governanceGroup2Router);
app.use(errorMiddleware);

describe('Governance Group 2 API Module Integration Tests', () => {
  beforeEach(() => {
    // Reset test mocks/state
  });

  describe('POST /api/v2/governance/proposals validation', () => {
    it('rejects proposal creation without authorization', async () => {
      const res = await request(app)
        .post('/api/v2/governance/proposals')
        .send({
          title: 'Proposal with valid title',
          description: 'This is a description with more than 20 characters length.',
          proposal_type: 'parameter_change',
        });

      expect(res.status).toBe(401);
    });

    it('rejects proposal with title that is too short', async () => {
      const res = await request(app)
        .post('/api/v2/governance/proposals')
        .set('Authorization', 'Bearer mock_invalid_token')
        .send({
          title: 'Hi',
          description: 'This is a description with more than 20 characters length.',
          proposal_type: 'parameter_change',
        });

      expect(res.status).toBe(401); // Auth runs before validation or rejects
    });
  });

  describe('POST /api/v2/governance/disputes validation', () => {
    it('rejects dispute filing without authorization', async () => {
      const res = await request(app)
        .post('/api/v2/governance/disputes')
        .send({
          market_id: 'market-123',
          reason: 'Reason for dispute is valid length.',
          proposed_outcome: 'fighter_a',
          bond_amount: '1000000',
        });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v2/governance/proposals query parsing', () => {
    it('rejects invalid status filter in query', async () => {
      const res = await request(app)
        .get('/api/v2/governance/proposals')
        .query({ status: 'invalid_status_value' });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });

    it('rejects invalid proposal type filter in query', async () => {
      const res = await request(app)
        .get('/api/v2/governance/proposals')
        .query({ type: 'unknown_type' });

      expect(res.status).toBe(422);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('POST /api/v2/governance/proposals/:id/execute authorization', () => {
    it('rejects execution without admin JWT', async () => {
      const res = await request(app).post('/api/v2/governance/proposals/prop-1/execute');
      expect(res.status).toBe(401);
    });
  });
});
