import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { trajectoryEvidenceRef } from '../../../src/studio/application/trajectory-evidence.js';
import type { ExperienceTimelineEvent } from '../../../src/observability/contracts/experience.js';

function event(
  id: string,
  sourceLineIndex?: number,
): ExperienceTimelineEvent {
  return {
    id,
    kind: 'assistant_message',
    sourceTrace: '/tmp/trace.jsonl',
    sessionId: 'session-1',
    order: sourceLineIndex ?? 0,
    sourceLineIndex,
    traceId: `trace-${id}`,
  };
}

describe('trajectory evidence references', () => {
  it('retains the normalized identity and raw-log locator', () => {
    assert.deepEqual(trajectoryEvidenceRef(event('event-3', 17)), {
      normalizedEventId: 'event-3',
      sourceLineIndex: 17,
      traceId: 'trace-event-3',
    });
  });
});
