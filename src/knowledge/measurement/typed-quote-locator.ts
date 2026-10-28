import { z } from 'zod';
import { EvidenceSelectionSchema } from './typed-contracts.js';

// Keep the original typed measurement schema object graph: draft evidence and
// mention/citation locators share the frozen contract primitives. Canonical body
// schema changes must not change published measurement prompt/wire rendering.
export const TypedQuoteOccurrenceLocatorSchema = EvidenceSelectionSchema.omit({ start: true, end: true }).extend({
  occurrence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
