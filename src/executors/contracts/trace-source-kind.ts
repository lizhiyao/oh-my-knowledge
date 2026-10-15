import { TraceSourceKindSchema } from './trace-source-schema.js';
import type { TraceSourceKind } from './trace-source.js';

export type { TraceSourceKind } from './trace-source.js';



/** Runtime validator for the persisted Trace IR source identity protocol. */
export function isTraceSourceKind(value: unknown): value is TraceSourceKind {
  return TraceSourceKindSchema.safeParse(value).success;
}
