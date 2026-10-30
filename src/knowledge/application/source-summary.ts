import type { SourceSnapshot, TraceOrigin } from '../sources.js';

type WithoutRawUnits<T> = T extends unknown ? Omit<T, 'rawUnits'> : never;
type SourceSummaryInput = WithoutRawUnits<SourceSnapshot>;

export function sourceOrigin(snapshot: SourceSummaryInput): Omit<TraceOrigin, 'cwd'> | undefined {
  const origin = snapshot.sourceKind === 'agent_trace' ? snapshot.origin : undefined;
  return origin ? { threadId: origin.threadId, ...(origin.turnId === undefined ? {} : { turnId: origin.turnId }), title: origin.title } : undefined;
}

/** A portable reader label and locator; neither declares currentness nor replaces the exact source reference. */
export function sourceSummary(snapshot: SourceSummaryInput) {
  const origin = sourceOrigin(snapshot);
  return { sourceKind: snapshot.sourceKind, identity: snapshot.identity, selection: snapshot.selection,
    material: snapshot.material, excerptCount: snapshot.excerpts.length,
    ...(origin ? { origin, title: origin.title } : snapshot.sourceKind === 'agent_trace' ? {} : { title: snapshot.identity.relativePath }) };
}
export type SourceSummary = ReturnType<typeof sourceSummary>;
