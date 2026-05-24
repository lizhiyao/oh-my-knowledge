import type { ObservationInboxItem } from '../../../src/observability/inbox.js';
import {
  resolveObservationReviewSession,
  type ResolvedObservationReviewSession,
} from '../../../src/observability/resolved-review.js';
import type {
  ExperienceChecklistItem,
  ObservationExperienceReport,
  ObservationReviewState,
} from '../../../src/observability/experience.js';

export function resolvedReviewSessionsForFixture(
  experience: ObservationExperienceReport,
  reviewState: ObservationReviewState,
): Record<string, ResolvedObservationReviewSession> {
  return Object.fromEntries(experience.sessions.map((session) => [session.id, resolveObservationReviewSession({
    session,
    enhancedReview: undefined,
    reviewState,
  })]));
}

export function businessActionTag(name: string, text: string): string {
  const tag = ['ai', 'ma-cmd'].join('');
  return `<${tag} name="${name}">${text}</${tag}>`;
}

export function businessChannel(): string {
  return ['ai', 'ma'].join('');
}

export function baseItem(partial: Partial<ObservationInboxItem>): ObservationInboxItem {
  return {
    id: partial.id ?? 'i1',
    skillName: partial.skillName ?? 'audit',
    artifactVersion: 'unknown',
    cwd: partial.cwd ?? '/repo-a',
    sessionId: partial.sessionId ?? 's1',
    sourceTrace: '/tmp/s1.jsonl',
    sourceKind: partial.sourceKind ?? 'claude',
    signalType: partial.signalType ?? 'failed_search',
    signalSubtype: partial.signalSubtype ?? 'hard_miss',
    confidence: partial.confidence ?? 0.9,
    attributionConfidence: partial.attributionConfidence ?? 0.85,
    severity: partial.severity ?? 'high',
    evidence: partial.evidence ?? { query: 'revenue_schema' },
    firstSeen: partial.firstSeen ?? '2026-05-01T00:00:00.000Z',
    lastSeen: partial.lastSeen ?? '2026-05-01T00:00:00.000Z',
    occurrences: partial.occurrences ?? 1,
    recentSessionIds: partial.recentSessionIds ?? [partial.sessionId ?? 's1'],
    representativeEvidence: partial.representativeEvidence ?? [partial.evidence ?? { query: 'revenue_schema' }],
  };
}

export function checklistItem(
  key: string,
  status: ExperienceChecklistItem['status'],
  contribution: ExperienceChecklistItem['contribution'],
): ExperienceChecklistItem {
  return {
    key,
    label: key,
    status,
    contribution,
    reason: key,
    evidenceRefs: [],
    source: 'deterministic_rule',
  };
}
