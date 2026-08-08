import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  primaryTrajectoryEvidenceRef,
  trajectoryEvidenceRef,
} from '../../src/renderer/trajectory-evidence.js';
import type { ExperienceTimelineEvent } from '../../src/types/index.js';

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

  it('prefers an event that can reach raw evidence', () => {
    assert.deepEqual(primaryTrajectoryEvidenceRef([
      event('normalized-only'),
      event('raw-backed', 23),
    ]), {
      normalizedEventId: 'raw-backed',
      sourceLineIndex: 23,
      traceId: 'trace-raw-backed',
    });
  });
});
