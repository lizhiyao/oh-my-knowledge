import { TraceSourceKindSchema } from '../contracts/trace-source-schema.js';
import type { TraceSourceKind } from '../contracts/trace-source.js';

export type { TraceSourceKind } from '../contracts/trace-source.js';



/** Runtime validator for the persisted Trace IR source identity protocol. */
export function isTraceSourceKind(value: unknown): value is TraceSourceKind {
  return TraceSourceKindSchema.safeParse(value).success;
}
