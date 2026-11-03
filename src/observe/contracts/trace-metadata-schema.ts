import { z } from 'zod';

export const TraceSourceMetadataSchema = z.object({
  channel: z.string().optional(),
  sender: z.string().optional(),
  senderId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  modelApi: z.string().optional(),
  businessActions: z.array(z.string()).optional(),
});
