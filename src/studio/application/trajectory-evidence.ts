import type { ExperienceTimelineEvent } from '../../observability/view-models/index.js';
import type { TrajectoryEvidenceRef } from '../view-models/trajectory-evidence.js';

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
