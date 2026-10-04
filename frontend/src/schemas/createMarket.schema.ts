import { z } from 'zod';

export const createMarketSchema = z
  .object({
    matchId: z.string().trim().min(1, 'Match ID is required'),
    fighterA: z.string().trim().min(1, 'Fighter A name is required'),
    fighterB: z.string().trim().min(1, 'Fighter B name is required'),
    startTime: z.string().min(1, 'Start Time is required'),
    endTime: z.string().min(1, 'End Time is required'),
    feeBps: z.coerce.number().min(0, 'Fee BPS must be >= 0').default(0),
    weightClass: z.string().optional().default('Lightweight'),
    venue: z.string().optional().default('TBA'),
    titleFight: z.boolean().optional().default(false),
    minBetXlm: z.coerce.number().min(0.1, 'Min bet must be at least 0.1 XLM').default(1),
    maxBetXlm: z.coerce.number().min(1, 'Max bet must be at least 1 XLM').default(100),
  })
  .refine(
    (data) => {
      const startMs = new Date(data.startTime).getTime();
      return !isNaN(startMs) && startMs > Date.now();
    },
    {
      message: 'Start Time must be in the future',
      path: ['startTime'],
    },
  )
  .refine(
    (data) => {
      const startMs = new Date(data.startTime).getTime();
      const endMs = new Date(data.endTime).getTime();
      return !isNaN(endMs) && endMs > startMs;
    },
    {
      message: 'End Time must be after Start Time',
      path: ['endTime'],
    },
  );

export type CreateMarketFormData = z.infer<typeof createMarketSchema>;
