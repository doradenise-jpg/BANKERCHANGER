import { z } from 'zod';

export const webhookTopicEnum = z.enum([
  'market.created',
  'market.locked',
  'market.resolved',
  'bet.placed',
  'dispute.opened',
  'dispute.resolved',
  'payout.distributed',
]);

export const webhookDeliveryStatusEnum = z.enum(['success', 'failed', 'pending', 'retrying']);

export const createWebhookGroup9BodySchema = z.object({
  url: z
    .string()
    .trim()
    .url('Target URL must be a valid URL')
    .refine((url) => url.startsWith('https://'), {
      message: 'Webhook target URL must use secure HTTPS protocol',
    }),
  secret: z
    .string()
    .trim()
    .min(16, 'Webhook secret must be at least 16 characters for HMAC-SHA256 signing')
    .max(64, 'Webhook secret cannot exceed 64 characters'),
  topics: z
    .array(webhookTopicEnum)
    .min(1, 'Must subscribe to at least one webhook topic')
    .max(10, 'Cannot subscribe to more than 10 topics per webhook endpoint'),
  description: z.string().trim().max(255, 'Description cannot exceed 255 characters').optional(),
});

export const webhookIdParamGroup9Schema = z.object({
  id: z.string().trim().min(1, 'Webhook ID is required').max(64, 'Webhook ID cannot exceed 64 characters'),
});

export const listDeliveriesGroup9QuerySchema = z.object({
  webhook_id: z.string().trim().optional(),
  status: webhookDeliveryStatusEnum.optional(),
  page: z.coerce.number().int().min(1, 'Page must be >= 1').default(1),
  limit: z.coerce.number().int().min(1, 'Limit must be >= 1').max(100, 'Limit cannot exceed 100').default(20),
});

export const replayWebhookDeliveriesGroup9BodySchema = z.object({
  delivery_ids: z
    .array(z.string().trim().min(1, 'Delivery ID cannot be empty'))
    .min(1, 'Must provide at least one delivery ID to replay')
    .max(50, 'Cannot replay more than 50 deliveries in a single batch'),
});

export type CreateWebhookGroup9Body = z.infer<typeof createWebhookGroup9BodySchema>;
export type WebhookIdParamGroup9 = z.infer<typeof webhookIdParamGroup9Schema>;
export type ListDeliveriesGroup9Query = z.infer<typeof listDeliveriesGroup9QuerySchema>;
export type ReplayWebhookDeliveriesGroup9Body = z.infer<typeof replayWebhookDeliveriesGroup9BodySchema>;
