import { z } from 'zod';

// --- Endpoint Group 21: User Activity & Preferences ---

export const getUserActivityQuery = z.object({
  userId: z.string().uuid().optional(),
  action: z.enum([
    'login', 'logout', 'bet_placed', 'bet_claimed',
    'profile_updated', '2fa_enabled', '2fa_disabled',
  ]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const updateUserPreferencesBody = z.object({
  emailNotifications: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  marketingEmails: z.boolean().optional(),
  defaultCurrency: z.enum(['USD', 'EUR', 'GBP', 'XLM']).optional(),
  oddsFormat: z.enum(['decimal', 'fractional', 'american']).optional(),
  language: z.enum(['en', 'es', 'fr', 'de', 'pt']).optional(),
  timezone: z.string().min(1).max(50).optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'At least one preference field must be provided' },
);

export const userPreferencesParam = z.object({
  userId: z.string().uuid(),
});

// --- Endpoint Group 22: Market Analytics & Reporting ---

export const marketAnalyticsQuery = z.object({
  marketId: z.string().uuid().optional(),
  period: z.enum(['1h', '6h', '24h', '7d', '30d']).default('24h'),
  metrics: z
    .array(z.enum([
      'total_volume', 'total_bets', 'unique_bettors',
      'avg_bet_size', 'liquidity_depth', 'odds_movement',
    ]))
    .min(1)
    .optional(),
});

export const generateReportBody = z.object({
  reportType: z.enum([
    'market_summary', 'user_activity', 'financial',
    'dispute_summary', 'provider_performance',
  ]),
  from: z.string().datetime(),
  to: z.string().datetime(),
  format: z.enum(['json', 'csv']).default('json'),
  filters: z.record(z.unknown()).optional(),
}).refine(
  (data) => new Date(data.to) > new Date(data.from),
  { message: 'End date must be after start date', path: ['to'] },
);

export const reportIdParam = z.object({
  reportId: z.string().uuid(),
});

// --- Endpoint Group 23: Transaction History & Export ---

export const getTransactionHistoryQuery = z.object({
  userId: z.string().uuid().optional(),
  type: z.enum(['bet', 'claim', 'refund', 'deposit', 'withdrawal']).optional(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  minAmount: z.coerce.number().positive().optional(),
  maxAmount: z.coerce.number().positive().optional(),
  sortBy: z.enum(['created_at', 'amount', 'status']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const exportTransactionsBody = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  filters: z.object({
    userId: z.string().uuid().optional(),
    type: z.enum(['bet', 'claim', 'refund', 'deposit', 'withdrawal']).optional(),
    status: z.enum(['pending', 'completed', 'failed', 'cancelled']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }).optional(),
  columns: z.array(z.string().min(1).max(50)).max(30).optional(),
});

// --- Endpoint Group 24: Notification & Alert Preferences ---

export const getNotificationSettingsParam = z.object({
  userId: z.string().uuid(),
});

export const updateNotificationSettingsBody = z.object({
  betPlaced: z.boolean().optional(),
  betResolved: z.boolean().optional(),
  betWon: z.boolean().optional(),
  claimProcessed: z.boolean().optional(),
  marketCreated: z.boolean().optional(),
  marketLocked: z.boolean().optional(),
  disputeFiled: z.boolean().optional(),
  disputeResolved: z.boolean().optional(),
  securityAlert: z.boolean().optional(),
  systemMaintenance: z.boolean().optional(),
  channel: z.enum(['email', 'push', 'both', 'none']).optional(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM').optional(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM').optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'At least one notification setting must be provided' },
);

export const testNotificationBody = z.object({
  type: z.enum(['email', 'push']),
  userId: z.string().uuid(),
  template: z.enum([
    'bet_placed', 'bet_resolved', 'security_alert',
    'system_maintenance',
  ]),
});

// --- Endpoint Group 25: System Health & Diagnostics ---

export const healthCheckQuery = z.object({
  components: z
    .array(z.enum(['database', 'redis', 'indexer', 'oracle', 'all']))
    .default(['all']),
  detailed: z.coerce.boolean().default(false),
});

export const systemDiagnosticsQuery = z.object({
  includeMetrics: z.coerce.boolean().default(true),
  includeConnections: z.coerce.boolean().default(true),
  includeCronJobs: z.coerce.boolean().default(false),
  includeRecentErrors: z.coerce.boolean().default(false),
  errorLimit: z.coerce.number().int().min(1).max(100).default(10),
});

export const componentStatusParam = z.object({
  component: z.enum(['database', 'redis', 'indexer', 'oracle']),
});
