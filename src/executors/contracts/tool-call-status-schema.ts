import { z } from 'zod';

export const ToolCallStatusSchema = z.enum([
  'success',
  'failure',
  'cancelled',
  'unknown',
]);
