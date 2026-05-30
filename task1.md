#741 [BACKEND] Implement Indexer::handleMarketResolved()
Repo Avatar
Netwalls/BOXMEOUT_STELLA
Implement handler for MarketResolved events.

Acceptance Criteria
 Updates market status to Resolved in DB
 Sets winning_outcome and resolved_at
 Invalidates all Redis cache keys for this market
 Creates an OracleReport record from the event data

 #744 [BACKEND] Implement MarketController::getMarket()
Repo Avatar
Netwalls/BOXMEOUT_STELLA
Implement GET /api/markets/:marketId.

Acceptance Criteria
 Validates marketId param is a valid numeric string
 Returns 404 if market not found
 Response includes current odds (calls calculateOdds())
 Cached with 10s TTL

 #746 [BACKEND] Implement BetController::getBetsByAddress()
Repo Avatar
Netwalls/BOXMEOUT_STELLA
Implement GET /api/bets/:address.

Acceptance Criteria
 Validates Stellar address format with regex or SDK helper
 Returns 400 for invalid address format
 Returns paginated bets with joined market data
 Returns empty array (not 404) for address with no bets

 #747 [BACKEND] Implement BetController::getBettorStats()
Repo Avatar
Netwalls/BOXMEOUT_STELLA
Implement GET /api/bets/:address/stats.

Acceptance Criteria
 Aggregates: total wagered, total winnings, total bets, win rate
 Computes favoriteFighter as the fighter bet on most often
 Cached for 60 seconds per address
 Returns zeroed stats (not 404) for addresses with no bets