import type { ExperienceTimelineEvent } from '../../observability/view-models/index.js';

export interface TrajectoryEvidenceRef {
  normalizedEventId: string;
  sourceLineIndex?: number;
  traceId?: string;
}

export function trajectoryEvidenceRef(
  event: ExperienceTimelineEvent | undefined,
): TrajectoryEvidenceRef | undefined {
  if (!event) return undefined;
  return {
    normalizedEventId: event.id,
    ...(event.sourceLineIndex !== undefined ? { sourceLineIndex: event.sourceLineIndex } : {}),
    ...(event.traceId ? { traceId: event.traceId } : {}),
  };
}

export function primaryTrajectoryEvidenceRef(
  events: ExperienceTimelineEvent[],
): TrajectoryEvidenceRef | undefined {
  return trajectoryEvidenceRef(
    events.find((event) => event.sourceLineIndex !== undefined) ?? events[0],
  );
}
