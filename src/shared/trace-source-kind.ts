import type { TraceSourceKind } from '../observability/contracts/trace.js';

const TRACE_SOURCE_KINDS = new Set<TraceSourceKind>([
  'claude',
  'codex',
  'dsh',
  'openclaw',
  'markdown_log',
  'unknown',
]);

/** Runtime validator for the persisted Trace IR source identity protocol. */
export function isTraceSourceKind(value: unknown): value is TraceSourceKind {
  return typeof value === 'string'
    && TRACE_SOURCE_KINDS.has(value as TraceSourceKind);
}
