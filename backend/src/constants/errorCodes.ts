/**
 * Machine-readable error codes for API responses
 * These codes help API consumers identify error types programmatically
 * without parsing error message strings
 */

export const ERROR_CODES = {
  // Validation Errors (4xx)
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_MARKET_ID: 'INVALID_MARKET_ID',
  INVALID_BET_AMOUNT: 'INVALID_BET_AMOUNT',
  INVALID_BET_SIDE: 'INVALID_BET_SIDE',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',

  // Market State Errors
  MARKET_NOT_FOUND: 'MARKET_NOT_FOUND',
  MARKET_LOCKED: 'MARKET_LOCKED',
  MARKET_RESOLVED: 'MARKET_RESOLVED',
  MARKET_DISPUTED: 'MARKET_DISPUTED',

  // Betting Errors
  BET_BELOW_MINIMUM: 'BET_BELOW_MINIMUM',
  BET_ABOVE_MAXIMUM: 'BET_ABOVE_MAXIMUM',
  BET_WINDOW_CLOSED: 'BET_WINDOW_CLOSED',

  // Claim/Withdrawal Errors
  NO_WINNINGS_TO_CLAIM: 'NO_WINNINGS_TO_CLAIM',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  WITHDRAWAL_LIMIT_EXCEEDED: 'WITHDRAWAL_LIMIT_EXCEEDED',
  CLAIM_FAILED: 'CLAIM_FAILED',

  // Authentication & Authorization
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  // Admin/Oracle Errors
  ADMIN_ONLY: 'ADMIN_ONLY',
  ORACLE_ONLY: 'ORACLE_ONLY',
  ORACLE_CONSENSUS_FAILED: 'ORACLE_CONSENSUS_FAILED',

  // Resource Errors
  NOT_FOUND: 'NOT_FOUND',
  RESOURCE_ALREADY_EXISTS: 'RESOURCE_ALREADY_EXISTS',

  // Database/Persistence Errors
  DATABASE_ERROR: 'DATABASE_ERROR',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',

  // Blockchain/Smart Contract Errors
  CONTRACT_EXECUTION_FAILED: 'CONTRACT_EXECUTION_FAILED',
  TRANSACTION_FAILED_ON_CHAIN: 'TRANSACTION_FAILED_ON_CHAIN',
  INSUFFICIENT_STELLAR_BALANCE: 'INSUFFICIENT_STELLAR_BALANCE',

  // Server Errors (5xx)
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

/**
 * Error code descriptions for documentation
 */
export const ERROR_CODE_DESCRIPTIONS: Record<ErrorCode, string> = {
  // Validation
  INVALID_REQUEST: 'The request body is invalid or missing required fields',
  INVALID_MARKET_ID: 'The provided market ID is invalid or not a number',
  INVALID_BET_AMOUNT: 'The bet amount is invalid (must be a positive number)',
  INVALID_BET_SIDE: 'The bet side is invalid (must be FIGHTER_A, FIGHTER_B, or DRAW)',
  INSUFFICIENT_BALANCE: 'User has insufficient balance for this operation',

  // Market State
  MARKET_NOT_FOUND: 'The market with the given ID does not exist',
  MARKET_LOCKED: 'The market is currently locked and does not accept new bets',
  MARKET_RESOLVED: 'The market has been resolved and no longer accepts bets',
  MARKET_DISPUTED: 'The market outcome is being disputed and awaiting admin resolution',

  // Betting
  BET_BELOW_MINIMUM: 'The bet amount is below the market minimum',
  BET_ABOVE_MAXIMUM: 'The bet amount exceeds the market maximum',
  BET_WINDOW_CLOSED: 'Betting window has closed for this market',

  // Claims
  NO_WINNINGS_TO_CLAIM: 'User has no winnings to claim in this market',
  ALREADY_CLAIMED: 'User has already claimed winnings from this market',
  WITHDRAWAL_LIMIT_EXCEEDED: 'Daily withdrawal limit has been exceeded',
  CLAIM_FAILED: 'Claim operation failed during execution',

  // Auth
  UNAUTHORIZED: 'User is not authenticated',
  FORBIDDEN: 'User does not have permission to access this resource',
  INVALID_CREDENTIALS: 'Provided credentials are invalid',
  TOKEN_EXPIRED: 'Authentication token has expired',

  // Admin/Oracle
  ADMIN_ONLY: 'This operation requires admin privileges',
  ORACLE_ONLY: 'This operation can only be performed by an oracle',
  ORACLE_CONSENSUS_FAILED: 'Oracle consensus not reached for market resolution',

  // Resources
  NOT_FOUND: 'The requested resource was not found',
  RESOURCE_ALREADY_EXISTS: 'A resource with this identifier already exists',

  // Database
  DATABASE_ERROR: 'A database operation failed',
  TRANSACTION_FAILED: 'Database transaction failed',

  // Blockchain
  CONTRACT_EXECUTION_FAILED: 'Smart contract execution failed',
  TRANSACTION_FAILED_ON_CHAIN: 'Transaction failed on the blockchain',
  INSUFFICIENT_STELLAR_BALANCE: 'Insufficient XLM balance to complete transaction',

  // Server
  INTERNAL_ERROR: 'An internal server error occurred',
  SERVICE_UNAVAILABLE: 'Service is temporarily unavailable',
  REQUEST_TIMEOUT: 'Request processing timed out',
};
