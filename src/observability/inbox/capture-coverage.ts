import type { ObservationCaptureCoverage } from '../contracts/inbox.js';

export function buildExplicitObservationCaptureCoverage(
  hasSubmittedEvidence: boolean,
): ObservationCaptureCoverage {
  return {
    coverageStatus: 'partial',
    capturePath: 'explicit_tool_call',
    observedEventKinds: [
      'tool_boundary',
      'user_feedback',
      ...(hasSubmittedEvidence ? ['submitted_evidence' as const] : []),
    ],
    unavailableEventKinds: ['full_conversation', 'external_tool_calls', 'hidden_reasoning'],
  };
}

export function isObservationCaptureCoverage(
  value: unknown,
): value is ObservationCaptureCoverage {
  if (!isRecord(value)) return false;
  const observed = value.observedEventKinds;
  const unavailable = value.unavailableEventKinds;
  return value.coverageStatus === 'partial'
    && value.capturePath === 'explicit_tool_call'
    && Array.isArray(observed)
    && observed.length === new Set(observed).size
    && observed.includes('tool_boundary')
    && observed.includes('user_feedback')
    && observed.every((item) =>
      item === 'tool_boundary' || item === 'user_feedback' || item === 'submitted_evidence'
    )
    && Array.isArray(unavailable)
    && unavailable.length === new Set(unavailable).size
    && unavailable.includes('full_conversation')
    && unavailable.includes('external_tool_calls')
    && unavailable.includes('hidden_reasoning')
    && unavailable.every((item) =>
      item === 'full_conversation' || item === 'external_tool_calls' || item === 'hidden_reasoning'
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
