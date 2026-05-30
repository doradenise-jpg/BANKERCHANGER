import { Router } from 'express';
import { claimWinnings, claimRefund, getBetsByAddress, getBettorStats } from '../api/controllers/BetController';

const router = Router();

// Claim endpoints (mounted at /api/claims)
router.post('/', claimWinnings);
router.post('/refund', claimRefund);

// Bet listing endpoints (also accessible via /api/bets when mounted there)
router.get('/:bettor_address/stats', getBettorStats);
router.get('/:bettor_address', getBetsByAddress);

export default router;
