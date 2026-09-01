import type { TraceSession } from './trace-ir.js';

export interface TraceSessionRef {
  traceId?: string;
  traceSessionId?: string;
  sessionId: string;
  sourceTrace?: string;
}

export interface TraceSessionIndex {
  resolve(ref: TraceSessionRef): TraceSession | undefined;
}

export function traceSessionRefIdentity(ref: TraceSessionRef): string {
  return ref.traceId
    ?? `${ref.sourceTrace ?? ''}\u0000${ref.traceSessionId ?? ref.sessionId}`;
}

/**
 * Resolve projected segments back to their physical evidence stream.
 *
 * `sourcePath` is not an identity: one Markdown log can contain many sessions.
 * Prefer the globally unique traceId, then source + concrete run id. Single-key
 * fallbacks are only retained when unambiguous.
 */
export function createTraceSessionIndex(sessions: TraceSession[]): TraceSessionIndex {
  const byTraceId = uniqueIndex(sessions, (session) => session.traceId);
  const bySourceAndRun = uniqueIndex(
    sessions,
    (session) => `${session.sourcePath}\u0000${session.runId}`,
  );
  const byRunId = uniqueIndex(sessions, (session) => session.runId);
  const bySourcePath = uniqueIndex(sessions, (session) => session.sourcePath);
  const byRootRunId = uniqueIndex(sessions, (session) => session.rootRunId);

  return {
    resolve(ref): TraceSession | undefined {
      if (ref.traceId) {
        return matchingSession(byTraceId.get(ref.traceId), ref);
      }
      if (ref.sourceTrace && ref.traceSessionId) {
        return matchingSession(
          bySourceAndRun.get(`${ref.sourceTrace}\u0000${ref.traceSessionId}`),
          ref,
        );
      }
      if (ref.traceSessionId) {
        const concrete = byRunId.get(ref.traceSessionId);
        if (concrete) return matchingSession(concrete, ref);
      }
      if (ref.sourceTrace) {
        const source = bySourcePath.get(ref.sourceTrace);
        if (source) return matchingSession(source, ref);
      }
      return matchingSession(
        byRootRunId.get(ref.sessionId) ?? byRunId.get(ref.sessionId),
        ref,
      );
    },
  };
}

function matchingSession(
  session: TraceSession | undefined,
  ref: TraceSessionRef,
): TraceSession | undefined {
  if (!session) return undefined;
  if (ref.traceId && session.traceId !== ref.traceId) return undefined;
  if (ref.sourceTrace && session.sourcePath !== ref.sourceTrace) return undefined;
  if (ref.traceSessionId && session.runId !== ref.traceSessionId) return undefined;
  if (session.rootRunId !== ref.sessionId) return undefined;
  return session;
}

function uniqueIndex(
  sessions: TraceSession[],
  keyFor: (session: TraceSession) => string,
): Map<string, TraceSession> {
  const index = new Map<string, TraceSession>();
  const ambiguous = new Set<string>();
  for (const session of sessions) {
    const key = keyFor(session);
    if (ambiguous.has(key)) continue;
    if (index.has(key)) {
      index.delete(key);
      ambiguous.add(key);
      continue;
    }
    index.set(key, session);
  }
  return index;
}
