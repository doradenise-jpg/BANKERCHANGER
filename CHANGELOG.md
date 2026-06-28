# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `Market::get_bet()` — view function returning a bettor's position (#716)
- `MarketFactory::get_open_market_ids()` — efficient open market filtering (#717)
- `Market::upgrade()` — admin-only WASM upgrade mechanism (#718)
- `create_market()` fee_bps override per market, capped at 1000 bps (#719)

## [0.4.0] - 2026-06-01

### Added
- `MarketService.getMarketById(market_id)` — single market lookup with Redis 10-second TTL caching (#727)
- `MarketService.getMarkets(filters, pagination)` — paginated listing with `fighter`, `status`, `weight_class`, `dateFrom`, `dateTo` filters (#726)
- Drizzle ORM integration with full schema: `markets`, `bets`, `blockchain_events`, `oracle_reports`, `notification_jobs`, `indexer_checkpoints` (#725)
- Live odds calculation: `odds_x = (pool_x * 10000) / total_pool` with on-chain fallback when DB data is stale (#727)
- `GET /api/markets` and `GET /api/markets/:market_id` REST endpoints (#726, #727)

### Changed
- `MarketService` — enhanced filters, cache invalidation via `invalidateMarketCache(market_id)` (#726, #727)
- `MarketController` — updated Zod validation schema and request handler (#726, #727)

## [0.3.0] - 2026-05-01

### Added
- Express server with TypeScript strict mode and hot reload via `ts-node-dev` (#724)
- PostgreSQL schema setup with Drizzle ORM and `npm run migrate` tooling (#725)
- `backend/src/services/MarketService.ts` — initial service skeleton (#726)

### Fixed
- Foreign key constraint on `bets → markets` enforced at schema level
- Unique indexes on `market_id` and `tx_hash` to prevent duplicate inserts

## [0.2.0] - 2026-04-01

### Added
- Soroban smart contracts: `Market` and `MarketFactory`
- Oracle reporting and dispute resolution flow
- Blockchain event indexer with checkpoint tracking

### Changed
- Switched from raw SQL to parameterized queries across all DB adapters

## [0.1.0] - 2026-03-01

### Added
- Initial monorepo scaffold: `backend/`, `frontend/`, `contracts/`, `indexer/`
- Docker Compose configuration for local development and CI
- `.env.example` with all required environment variables documented
- `SECURITY.md` with responsible disclosure policy

[Unreleased]: https://github.com/doradenise-jpg/BANKERCHANGER/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/doradenise-jpg/BANKERCHANGER/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/doradenise-jpg/BANKERCHANGER/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/doradenise-jpg/BANKERCHANGER/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/doradenise-jpg/BANKERCHANGER/releases/tag/v0.1.0
