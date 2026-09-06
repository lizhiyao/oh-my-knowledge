import type {
  ExperienceFeedbackSignal,
  ExperienceReviewIndicators,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
  ObservationExperienceReport,
} from '../contracts/experience.js';
import type { ObservationMetricKey, ObservationReviewState } from '../contracts/review.js';
import type { SkillDerivedStandards } from '../soft-standards/types.js';
import {
  assistiveInferenceForEvidence,
  ruleFindingsForEvidence,
  timelineIndicators,
} from '../experience.js';
import {
  basisCodesForIndicators,
  priorityForReviewerFindings,
  priorityForScore,
  scoreForIndicators,
  sumIndicators,
} from '../experience/report-derivations.js';
import {
  canonicalFeedbackCountsForSession,
  canonicalFeedbackSignalsForSession,
  metricKeyForFeedbackSignal,
} from '../experience/review-checklist.js';
import { isAssistantDeliveryEvent } from '../experience/timeline.js';
import { buildSessionStory } from '../experience/session-story.js';
import { buildReviewerReport } from '../experience/reviewer-report.js';
import { observationMetricAnnotationVerdict } from './review-state.js';
import { resolveObservationReviewSession, type ResolvedObservationReviewSession } from './resolved-review.js';
import { ownRecordValue, setOwnRecordValue } from '../../shared/record-count.js';

export const INDICATOR_FOR_METRIC = {
  user_follow_up: 'userFollowUpCount',
  user_correction: 'userCorrectionCount',
  user_interruption: 'userInterruptionCount',
  negative_feedback: 'negativeFeedbackCount',
  positive_feedback: 'positiveFeedbackCount',
  user_goal_shift: 'userGoalShiftCount',
  hard_rule: 'hardRuleTextHitCount',
  completion_result: 'assistantDeliverySignalCount',
  deliverable_artifact: 'deliverableArtifactSignalCount',
  self_correction: 'selfCorrectionCount',
  repeated_execution: 'repeatedExecutionCount',
} as const satisfies Partial<Record<ObservationMetricKey, keyof ExperienceReviewIndicators>>;

export interface EffectiveObservationReview {
  /** Read-only derived views; never persist these over the source reports. */
  effectiveExperienceReports: ObservationExperienceReport[];
  resolvedReviewSessions: Record<string, ResolvedObservationReviewSession>;
  unappliedMetricAnnotations: Record<string, ObservationMetricKey[]>;
}

function attributedTimeline(session: ExperienceSessionSummary): ExperienceTimelineEvent[] | undefined {
  const ids = new Set(session.attributedEventIds);
  if (ids.size === 0 || ids.size !== session.timelineScope.segmentEventCount) return undefined;
  const events = new Map([...session.timelinePreview, ...session.fullSessionTimeline].map((event) => [event.id, event]));
  const timeline = [...ids].map((id) => events.get(id));
  if (timeline.some((event) => !event)) return undefined;
  return timeline as ExperienceTimelineEvent[];
}

function reviewedIndicators(
  session: ExperienceSessionSummary,
  report: ObservationExperienceReport,
  reviewState: ObservationReviewState,
): { indicators: ExperienceReviewIndicators; unapplied: ObservationMetricKey[] } {
  const indicators = { ...session.indicators };
  const timeline = attributedTimeline(session);
  const visible = timeline ?? session.timelinePreview;
  const canonical = canonicalFeedbackSignalsForSession(session);
  const allCanonical = session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [];
  const unapplied: ObservationMetricKey[] = [];
  const group = report.invocations.filter((invocation) => session.invocationIds.includes(invocation.id));
  const canReplayInvocations = group.length > 0 && group.length === session.invocationIds.length
    && group.every((invocation) => invocation.timeline.length > 0
      && (invocation.timelineEventIds === undefined
        || invocation.timelineEventIds.every((id) => invocation.timeline.some((event) => event.id === id))));
  for (const [metricKey, field] of Object.entries(INDICATOR_FOR_METRIC) as Array<[keyof typeof INDICATOR_FOR_METRIC, typeof INDICATOR_FOR_METRIC[keyof typeof INDICATOR_FOR_METRIC]]>) {
    const refs = [...visible, ...canonical.map((signal) => signal.evidenceRef)];
    const annotated = refs.some((ref) => observationMetricAnnotationVerdict(reviewState, { ...ref, metricScopeId: session.id }, metricKey));
    if (!annotated) continue;
    if (allCanonical.length > 0 && canonical.some((signal) => metricKeyForFeedbackSignal(signal) === metricKey)) continue;
    if (!timeline || (metricKey === 'repeated_execution'
      && timeline.filter((event) => event.kind === 'tool_use').length !== session.indicators.toolCallCount)) {
      unapplied.push(metricKey);
      continue;
    }
    if (metricKey === 'completion_result') {
      indicators[field] = timeline.filter((event) => {
        if (event.kind !== 'assistant_message') return false;
        const verdict = observationMetricAnnotationVerdict(reviewState, event, metricKey);
        return verdict === 'confirmed' || (verdict !== 'rejected' && isAssistantDeliveryEvent(event));
      }).length;
      continue;
    }
    const counts = canReplayInvocations
      ? sumIndicators(group.map((invocation) => ({ ...invocation.indicators, ...timelineIndicators(invocation.timeline, session.id, reviewState) })))
      : timelineIndicators(timeline, session.id, reviewState);
    indicators[field] = counts[field];
  }
  // Canonical attribution owns feedback counts, including downstream ownership.
  // The domain helper retains stored counts when canonical evidence is absent.
  Object.assign(indicators, canonicalFeedbackCountsForSession({ ...session, indicators }, reviewState));
  return { indicators, unapplied };
}

/** Shared CLI/API/Studio projection. Raw evidence and review state remain separate. */
export function projectEffectiveObservationReview(
  reports: ObservationExperienceReport[],
  reviewState: ObservationReviewState,
  derivedStandards: Record<string, SkillDerivedStandards> = {},
): EffectiveObservationReview {
  const resolvedReviewSessions: EffectiveObservationReview['resolvedReviewSessions'] = {};
  const unappliedMetricAnnotations: EffectiveObservationReview['unappliedMetricAnnotations'] = {};
  const effectiveExperienceReports = reports.map((report) => {
    const sessions = report.sessions.map((raw) => {
      const { indicators, unapplied } = reviewedIndicators(raw, report, reviewState);
      if (unapplied.length > 0) setOwnRecordValue(unappliedMetricAnnotations, raw.id, unapplied);
      const timeline = attributedTimeline(raw) ?? raw.timelinePreview;
      const observations = raw.ruleFindings.flatMap((finding) => finding.evidenceRefs).filter((ref) => ref.kind === 'observation');
      const findings = ruleFindingsForEvidence(indicators, timeline, observations, raw.evidenceChain, raw.id, reviewState);
      const feedbackTypes: Partial<Record<(typeof findings)[number]['code'], ExperienceFeedbackSignal['type']>> = {
        user_correction_seen: 'correction', user_interruption_seen: 'interruption',
        negative_feedback_seen: 'frustration', positive_feedback_seen: 'positive',
      };
      const activeSignals = canonicalFeedbackSignalsForSession(raw, reviewState);
      for (const finding of findings) {
        const signalType = feedbackTypes[finding.code];
        if (!signalType) continue;
        const refs = activeSignals.filter((signal) => signal.type === signalType).map((signal) => signal.evidenceRef);
        if (refs.length > 0) finding.evidenceRefs = refs.slice(0, 5);
      }
      let session: ExperienceSessionSummary = {
        ...raw,
        indicators,
        reviewPriorityScore: scoreForIndicators(indicators),
        reviewBasisCodes: basisCodesForIndicators(indicators),
        ruleFindings: findings,
        assistiveInference: assistiveInferenceForEvidence(indicators, raw.evidenceChain, findings),
      };
      const group = report.invocations.filter((invocation) => raw.invocationIds.includes(invocation.id));
      if (raw.reviewerReport && raw.sessionStory && attributedTimeline(raw)) {
        const storyInvocations = report.invocations.filter((invocation) => group.some((own) => own.sessionGroupKey === invocation.sessionGroupKey));
        const story = buildSessionStory(session, storyInvocations, raw.sessionStory.episodes, reviewState);
        session = { ...session, sessionStory: story };
        session.reviewerReport = buildReviewerReport(session, group, report.generatedAt, reviewState, storyInvocations, story);
      }
      session.reviewPriority = session.reviewerReport
        ? priorityForReviewerFindings(session, session.reviewerReport.findings)
        : priorityForScore(session.reviewPriorityScore);
      const resolved = resolveObservationReviewSession({ session, reviewState, enhancedReview: ownRecordValue(derivedStandards, raw.skillName)?.enhancedReview });
      setOwnRecordValue(resolvedReviewSessions, raw.id, resolved);
      // Preserve the deterministic result above in the resolved source; the view
      // uses the final priority consistently for rows, cards, and skill totals.
      return { ...session, reviewPriority: resolved.priority };
    });
    const skills = report.skills.map((skill) => {
      const own = sessions.filter((session) => session.skillName === skill.skillName);
      const indicators = sumIndicators(own.map((session) => session.indicators));
      const findings = ruleFindingsForEvidence(indicators, own.flatMap((session) => attributedTimeline(session) ?? session.timelinePreview), [], skill.evidenceChain, '', reviewState);
      return {
        ...skill,
        indicators,
        reviewFirstSessionCount: own.filter((session) => session.reviewPriority === 'review_first').length,
        sampleReviewSessionCount: own.filter((session) => session.reviewPriority === 'sample_review').length,
        ruleFindings: findings,
        assistiveInference: assistiveInferenceForEvidence(indicators, skill.evidenceChain, findings),
      };
    });
    return { ...report, sessions, skills };
  });
  return { effectiveExperienceReports, resolvedReviewSessions, unappliedMetricAnnotations };
}
