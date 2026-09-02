import { z } from 'zod';
import type { Assertion } from '../contracts/assertion.js';
import {
  ASYNC_ASSERTION_TYPE_NAMES,
  SYNC_ASSERTION_TYPE_NAMES,
} from '../../shared/assertion-types.js';

const JsonObjectSchema = z.record(z.string(), z.json());

/** Strict authoring shape. Type-specific and recursive semantic rules are checked separately. */
export const AssertionSchema: z.ZodType<Assertion> = z.lazy(() => z.object({
  type: z.enum([...SYNC_ASSERTION_TYPE_NAMES, ...ASYNC_ASSERTION_TYPE_NAMES]),
  value: z.union([
    z.string(),
    z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  ]).optional(),
  values: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  flags: z.string().optional(),
  schema: JsonObjectSchema.optional(),
  weight: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  fn: z.string().optional(),
  reference: z.string().optional(),
  threshold: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  not: z.boolean().optional(),
  mode: z.enum(['any', 'all']).optional(),
  children: z.array(AssertionSchema).optional(),
  n: z.number().int().safe().optional(),
}).strict());
