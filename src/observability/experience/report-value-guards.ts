import {
  ExperienceMetaSchema,
  ExperienceAttributionSchema,
  ExperienceReviewIndicatorsSchema,
  ExperienceReviewIndicatorsWireSchema,
  ExperienceTimelineScopeSchema,
} from '../contracts/experience-evidence-schema.js';
import {
  ExperienceTimelineEventSchema,
  ExperienceTimelineBranchSchema,
  ExperienceTimelineTreeSchema,
  ExperienceTraceTimelineSchema,
  ExperienceTurnSummarySchema,
  ExperienceTimelineAttachmentSchema,
} from '../contracts/experience-evidence-schema.js';
import {
  ExperienceReviewerReportStepSchema,
  ExperienceReviewerReportFindingSchema,
  ExperienceReviewerMetricsWireSchema,
  ExperienceSessionStoryWireSchema,
  ExperienceReviewerReportWireSchema,
} from '../contracts/experience-evidence-schema.js';
import {
  ExperienceGoalEvidenceRefSchema,
  ExperienceSkillSegmentSchema,
  ExperienceOrchestrationEdgeSchema,
  ExperienceFeedbackAttributionSchema,
  ExperienceFeedbackSignalSchema,
  ExperienceEpisodeArtifactSchema,
  ExperienceEpisodeOutcomeSchema,
  ExperienceEpisodeSchema,
  ExperienceStoryContextSchema,
} from '../contracts/experience-evidence-schema.js';
import {
  ExperienceSessionStoryGoalSliceSchema,
  ExperienceSessionStorySubagentDispatchSchema,
  ExperienceSessionStorySkillLinkSchema,
  ExperienceSessionStoryGraphNodeSchema,
  ExperienceSessionStoryGraphEdgeSchema,
  ExperienceSessionStoryNodeSchema,
  ExperienceSessionStoryAnswerSchema,
} from '../contracts/experience-evidence-schema.js';
import { ExperienceInvocationMetricsWireSchema } from '../contracts/experience-evidence-schema.js';
import { ExperienceTraceRecordRangeSchema } from '../contracts/experience-evidence-schema.js';
import {
  ExperienceEvidenceChainSchema,
  ExperienceRuleFindingSchema,
  ExperienceAssistiveInferenceSchema,
  ExperienceChecklistItemSchema,
} from '../contracts/experience-evidence-schema.js';
import { ExperienceEvidenceRefSchema } from '../contracts/experience-evidence-schema.js';
import {
  ExperienceEvidenceKindSchema,
  ExperienceReviewBasisCodeSchema,
  ExperienceReviewPrioritySchema,
} from '../contracts/experience-enums.js';
import {
  isTraceSourceKind,
} from '../../executors/core/trace-source-kind.js';
import type {
  ExperienceEvidenceRef,
  ExperienceInvocation,
  ExperienceSessionSummary,
  ExperienceStoryContext,
  ExperienceTimelineEvent,
  ExperienceTraceRecordRange,
  ExperienceTraceTimeline,
  ExperienceTimelineTree,
  ExperienceTurnSummary,
} from '../contracts/experience.js';
import {
  normalizeTraceTimestamp,
} from '../trace/trace-ir.js';
import {
  hashParts,
  isObjectRecord,
} from './primitives.js';
import {
  durationMsBetween,
} from '../../shared/time.js';

export function normalizeExperienceInvocationShells(
  values: unknown[],
): ExperienceInvocation[] | null {
  const records = values.filter(isObjectRecord);
  if (records.length !== values.length) return null;
  if (records.some((value) =>
    typeof value.id !== 'string'
    || typeof value.skillName !== 'string'
    || typeof value.sessionId !== 'string'
    || typeof value.sessionGroupKey !== 'string'
    || typeof value.traceId !== 'string'
    || typeof value.sourceTrace !== 'string'
    || !isTraceSourceKind(value.sourceKind)
    || !isOptionalString(value.entrypoint)
    || !isOptionalTraceSourceMetadata(value.sourceMetadata)
    || !isOptionalString(value.cwd)
    || !isNonNegativeInteger(value.segmentIndex)
    || typeof value.goalSliceId !== 'string'
    || !isTimestampRange(value.startTimestamp, value.endTimestamp)
    || typeof value.timestampObserved !== 'boolean'
    || !isExperienceAttribution(value.attribution)
    || !isExperienceInvocationMetrics(value.metrics)
    || !isCountRecord(value.toolCounts)
    || !isExperienceIndicators(value.indicators)
    || !isExperienceEvidenceChain(value.evidenceChain)
    || !isExperienceRuleFindingArray(value.ruleFindings)
    || !isExperienceAssistiveInference(value.assistiveInference)
    || !isExperienceProblemPatternArray(value.problemPatterns)
    || !isStringArray(value.relatedObservationIds)
    || !isExperienceEvidenceRefArray(value.evidenceRefs)
    || (typeof value.timelineRef !== 'string'
      || !isStringArray(value.timelineEventIds)
      || (value.timeline !== undefined && !isTimelineEventArray(value.timeline)))
  )) return null;
  return records.map((value) => ({
    ...value,
    metrics: {
      ...(value.metrics as ExperienceInvocation['metrics']),
    },
    timeline: isTimelineEventArray(value.timeline)
      ? value.timeline as ExperienceTimelineEvent[]
      : [],
  } as ExperienceInvocation));
}

export function normalizeExperienceSessionShells(
  values: unknown[],
): ExperienceSessionSummary[] | null {
  const records = values.filter(isObjectRecord);
  if (records.length !== values.length) return null;
  if (records.some((value) =>
    typeof value.id !== 'string'
    || typeof value.skillName !== 'string'
    || !isOptionalString(value.threadId)
    || !isOptionalString(value.sourceThreadId)
    || typeof value.sessionId !== 'string'
    || typeof value.sourceTrace !== 'string'
    || !isTraceSourceKind(value.sourceKind)
    || !isOptionalString(value.entrypoint)
    || !isOptionalTraceSourceMetadata(value.sourceMetadata)
    || !isOptionalString(value.cwd)
    || !isConsistentSourceSessionTime(value)
    || !isTimestampRange(value.startTimestamp, value.endTimestamp)
    || !isStringArray(value.invocationIds)
    || !isOptionalTimestampCoverage(
      value.timestampedInvocationCount,
      value.timestampCoverage,
      Array.isArray(value.invocationIds) ? value.invocationIds.length : -1,
    )
    || (
      !isNonNegativeInteger(value.timestampedInvocationCount)
      || !isRate(value.timestampCoverage)
    )
    || !isStringArray(value.goalSliceIds)
    || !isExperienceReviewPriority(value.reviewPriority)
    || typeof value.reviewPriorityScore !== 'number'
    || !Number.isFinite(value.reviewPriorityScore)
    || value.reviewPriorityScore < 0
    || !isEnumArray(value.reviewBasisCodes, ExperienceReviewBasisCodeSchema.options)
    || !isExperienceIndicators(value.indicators)
    || !isExperienceEvidenceChain(value.evidenceChain)
    || !isExperienceRuleFindingArray(value.ruleFindings)
    || !isExperienceAssistiveInference(value.assistiveInference)
    || !isExperienceProblemPatternArray(value.problemPatterns)
    || !isStringArray(value.relatedObservationIds)
    || (value.turns !== undefined && !isExperienceTurnSummaryArray(value.turns))
    || !isExperienceTimelineScope(value.timelineScope)
    || !isStringArray(value.attributionSources)
    || !isStringArray(value.pluginNames)
    || !isStringArray(value.rawSkillRefs)
    || !isStringArray(value.commandNames)
    || (typeof value.timelineRef !== 'string'
      || !isStringArray(value.timelinePreviewEventIds)
      || (value.timelinePreview !== undefined && !isTimelineEventArray(value.timelinePreview))
      || (value.fullSessionTimeline !== undefined && !isTimelineEventArray(value.fullSessionTimeline)))
    || (value.timelineTree !== undefined && !isTimelineTree(value.timelineTree))
    || (
      value.sessionStory !== undefined
      && !isExperienceSessionStory(value.sessionStory)
    )
    || (
      value.reviewerReport !== undefined
      && !isExperienceReviewerReport(value.reviewerReport)
    )
  )) return null;
  return records.map((value) => {
    const sourceThreadId = typeof value.sourceThreadId === 'string'
      ? value.sourceThreadId
      : typeof value.threadId === 'string'
        ? value.threadId
        : value.sessionId as string;
    const threadId = typeof value.threadId === 'string'
      ? value.threadId
      : hashParts('thread', sourceThreadId);
    const sessionStory = isObjectRecord(value.sessionStory)
      ? {
        ...value.sessionStory,
        goalSlices: Array.isArray(value.sessionStory.goalSlices) ? value.sessionStory.goalSlices : [],
        subagentDispatches: Array.isArray(value.sessionStory.subagentDispatches)
          ? value.sessionStory.subagentDispatches
          : [],
        episodes: Array.isArray(value.sessionStory.episodes) ? value.sessionStory.episodes : [],
      }
      : undefined;
    return {
      ...value,
      threadId,
      sourceThreadId,
      invocationIds: Array.isArray(value.invocationIds) ? value.invocationIds : [],
      turns: isExperienceTurnSummaryArray(value.turns) ? value.turns : [],
      timelinePreview: Array.isArray(value.timelinePreview) ? value.timelinePreview : [],
      fullSessionTimeline: Array.isArray(value.fullSessionTimeline) ? value.fullSessionTimeline : [],
      sessionStory,
    } as ExperienceSessionSummary;
  });
}

export function normalizeTraceTimelines(values: unknown[]): ExperienceTraceTimeline[] | null {
  if (values.some((value) => !isObjectRecord(value)
    || !TraceTimelineShellSchema.safeParse(value).success
    || !isTimelineTree(value.tree))) return null;
  return values as ExperienceTraceTimeline[];
}

export function normalizeStoryContexts(values: unknown[]): ExperienceStoryContext[] | null {
  if (values.some((value) => !isExperienceStoryContext(value))) return null;
  return values as ExperienceStoryContext[];
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isOptionalTimestampCoverage(
  count: unknown,
  coverage: unknown,
  total: number,
): boolean {
  if (count === undefined && coverage === undefined) return true;
  if (
    total < 0
    || !isNonNegativeInteger(count)
    || count > total
    || !isRate(coverage)
  ) return false;
  return coverage === (total > 0 ? count / total : 0);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && normalizeTraceTimestamp(value) !== undefined;
}

export function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

export function isTimestampRange(start: unknown, end: unknown): boolean {
  if (!isTimestamp(start) || !isTimestamp(end)) return false;
  return Date.parse(start) <= Date.parse(end);
}

export function isConsistentSourceSessionTime(value: Record<string, unknown>): boolean {
  const start = value.sourceSessionStartTimestamp;
  const end = value.sourceSessionEndTimestamp;
  const duration = value.sourceSessionDurationMs;
  if (!isOptionalTimestamp(start) || !isOptionalTimestamp(end)) return false;
  if (duration !== undefined && !isNonNegativeInteger(duration)) return false;
  if (start === undefined || end === undefined) return duration === undefined;
  return typeof start === 'string'
    && typeof end === 'string'
    && isTimestampRange(start, end)
    && duration === durationMsBetween(start, end);
}

export function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

export function isEnumValue(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}

export function isEnumArray(value: unknown, values: readonly string[]): boolean {
  return Array.isArray(value) && value.every((item) => isEnumValue(item, values));
}

export function isExperienceMeta(value: unknown): boolean {
  return ExperienceMetaSchema.safeParse(value).success;
}

export function isOptionalTraceSourceMetadata(value: unknown): boolean {
  if (value === undefined) return true;
  return isObjectRecord(value)
    && isOptionalString(value.channel)
    && isOptionalString(value.sender)
    && isOptionalString(value.senderId)
    && isOptionalString(value.provider)
    && isOptionalString(value.model)
    && isOptionalString(value.modelApi)
    && (value.businessActions === undefined || isStringArray(value.businessActions));
}

export function isExperienceReviewPriority(value: unknown): boolean {
  return isEnumValue(value, ExperienceReviewPrioritySchema.options);
}

export function isExperienceEvidenceKind(value: unknown): boolean {
  return isEnumValue(value, ExperienceEvidenceKindSchema.options);
}

export function isExperienceEvidenceRef(value: unknown): value is ExperienceEvidenceRef {
  const parsed = ExperienceEvidenceRefSchema.safeParse(value);
  return parsed.success && isOptionalTimestamp(parsed.data.timestamp);
}

export function isExperienceEvidenceRefArray(value: unknown): value is ExperienceEvidenceRef[] {
  return Array.isArray(value) && value.every(isExperienceEvidenceRef);
}

export function isExperienceEvidenceChain(value: unknown): boolean {
  const parsed = ExperienceEvidenceChainSchema.safeParse(value);
  if (!parsed.success) return false;
  return [
    parsed.data.firstUserMessage,
    parsed.data.firstRuntimeContext,
    parsed.data.firstSkillContext,
    parsed.data.firstToolUse,
    parsed.data.firstToolFailure,
    parsed.data.lastAssistantMessage,
  ].every((ref) => ref === undefined || isExperienceEvidenceRef(ref));
}

export function isExperienceRuleFinding(value: unknown): boolean {
  const parsed = ExperienceRuleFindingSchema.safeParse(value);
  return parsed.success && isExperienceEvidenceRefArray(parsed.data.evidenceRefs);
}

export function isExperienceRuleFindingArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isExperienceRuleFinding);
}

export function isExperienceAssistiveInference(value: unknown): boolean {
  const parsed = ExperienceAssistiveInferenceSchema.safeParse(value);
  return parsed.success && isExperienceEvidenceRefArray(parsed.data.evidenceRefs);
}

export function isExperienceProblemEvidenceRef(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || typeof value.kind !== 'string'
    || typeof value.sourceTrace !== 'string'
    || typeof value.sessionId !== 'string'
    || !isOptionalNonNegativeInteger(value.messageIndex)
    || !isOptionalNonNegativeInteger(value.logicalMessageIndex)
    || !isOptionalNonNegativeInteger(value.sourceLineIndex)
  ) return false;
  if (
    value.role !== undefined
    && !isEnumValue(value.role, ['user', 'assistant', 'tool', 'other'])
  ) return false;
  return [
    value.messageUuid,
    value.traceId,
    value.callInstanceId,
    value.toolUseId,
    value.label,
    value.snippet,
  ].every(isOptionalString)
    && isOptionalTimestamp(value.timestamp);
}

export function isExperienceProblemPattern(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isEnumValue(value.bucket, [
      'output_format',
      'content_accuracy',
      'missing_context',
      'rule_violation',
      'workflow_mismatch',
      'tool_runtime',
      'goal_shift',
      'unclear',
    ])
    && typeof value.patternKey === 'string'
    && isNonNegativeInteger(value.count)
    && isNonNegativeInteger(value.sessionCount)
    && isStringArray(value.recentSessionIds)
    && isEnumArray(value.signalTypes, [
      'user_correction',
      'negative_feedback',
      'user_interruption',
      'hard_rule',
      'user_goal_shift',
      'tool_failure',
      'workflow_mismatch',
      'artifact_missing',
      'observer_lifecycle_failed',
      'orchestration_boundary_violation',
    ])
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.every(isExperienceProblemEvidenceRef)
    && isOptionalTimestamp(value.lastSeen);
}

export function isExperienceProblemPatternArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isExperienceProblemPattern);
}

export function isExperienceAttribution(value: unknown): boolean {
  const parsed = ExperienceAttributionSchema.safeParse(value);
  return parsed.success && isRate(parsed.data.confidence);
}

export function isExperienceInvocationMetrics(value: unknown): boolean {
  const parsed = ExperienceInvocationMetricsWireSchema.safeParse(value);
  if (!parsed.success) return false;
  const metrics = parsed.data;
  return metrics.numToolFailures + metrics.numToolCancelled + metrics.numToolUnknown
    <= metrics.numToolCalls;
}

export const EXPERIENCE_INDICATOR_KEYS = ExperienceReviewIndicatorsSchema.omit({
  toolCancelledCount: true,
  toolUnknownCount: true,
}).keyof().options;

export function isExperienceIndicators(value: unknown): boolean {
  const parsed = ExperienceReviewIndicatorsWireSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return data.toolFailureCount + data.toolCancelledCount + data.toolUnknownCount <= data.toolCallCount;
}

export function isCountRecord(value: unknown): boolean {
  return isObjectRecord(value)
    && Object.values(value).every(isNonNegativeInteger);
}

export function isExperienceTimelineScope(value: unknown): boolean {
  const parsed = ExperienceTimelineScopeSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return isExperienceTraceRecordRangeArray(data.segmentRecordRanges)
    && isExperienceTraceRecordRangeArray(data.previewRecordRanges)
    && isExperienceTraceRecordRangeArray(data.sessionRecordRanges)
    && data.previewEventCount <= data.segmentEventCount
    && data.segmentEventCount <= data.fullSessionEventCount
    && data.omittedBeforeCount + data.omittedAfterCount <= data.fullSessionEventCount;
}

export function isExperienceTraceRecordRangeArray(value: unknown): value is ExperienceTraceRecordRange[] {
  if (!Array.isArray(value)) return false;
  const identities = new Set<string>();
  for (const range of value) {
    if (
      !ExperienceTraceRecordRangeSchema.safeParse(range).success
      || range.startRecordIndex > range.endRecordIndex
      || range.eventCount === 0
      || identities.has(range.traceId)
    ) return false;
    identities.add(range.traceId);
  }
  return true;
}

export function isTimelineEvent(value: unknown): value is ExperienceTimelineEvent {
  if (!isObjectRecord(value)) return false;
  // Preserve the historical kind coercion only for validation, never for persisted output.
  const parsed = ExperienceTimelineEventSchema.safeParse({ ...value, kind: String(value.kind) });
  if (!parsed.success
    || !isOptionalTimestamp(parsed.data.timestamp)
    || (value.attachments !== undefined && !isTimelineAttachmentArray(value.attachments))) return false;
  return value.kind !== 'tool_result'
    || value.toolStatus === undefined
    || value.isError === undefined
    || value.isError === (value.toolStatus === 'failure');
}

export function isTimelineAttachmentArray(value: unknown): value is NonNullable<ExperienceTimelineEvent['attachments']> {
  return Array.isArray(value) && value.every((attachment) => {
    const parsed = ExperienceTimelineAttachmentSchema.safeParse(attachment);
    return parsed.success && parsed.data.name.length > 0;
  });
}

export function isTimelineEventArray(value: unknown): value is ExperienceTimelineEvent[] {
  return Array.isArray(value) && value.every(isTimelineEvent);
}

export function isExperienceTurnSummaryArray(value: unknown): value is ExperienceTurnSummary[] {
  return Array.isArray(value) && value.every((turn) => {
    const parsed = ExperienceTurnSummarySchema.safeParse(turn);
    return parsed.success
      && isOptionalTimestamp(parsed.data.startTimestamp)
      && isOptionalTimestamp(parsed.data.endTimestamp);
  });
}

export function isTimelineTree(value: unknown): value is ExperienceTimelineTree {
  if (!isObjectRecord(value)
    || !TimelineTreeShellSchema.safeParse(value).success
    || !isTimelineEventArray(value.main)
    || !Array.isArray(value.branches)) return false;
  return value.branches.every((branch) => isObjectRecord(branch)
    && TimelineBranchShellSchema.safeParse(branch).success
    && isTimelineEventArray(branch.events));
}

export function isExperienceChecklistItem(value: unknown): boolean {
  const parsed = ExperienceChecklistItemSchema.safeParse(value);
  return parsed.success && isExperienceEvidenceRefArray(parsed.data.evidenceRefs);
}

export function isExperienceSessionStoryGoalSlice(value: unknown): boolean {
  const parsed = ExperienceSessionStoryGoalSliceSchema.safeParse(value);
  return parsed.success
    && isTimestampRange(parsed.data.startTimestamp, parsed.data.endTimestamp)
    && isExperienceEvidenceRefArray(parsed.data.evidenceRefs);
}

export function isExperienceSessionStorySubagentDispatch(value: unknown): boolean {
  const parsed = ExperienceSessionStorySubagentDispatchSchema.safeParse(value);
  return parsed.success
    && isExperienceEvidenceRefArray(parsed.data.evidenceRefs);
}

export function isExperienceSessionStorySkillLink(value: unknown): boolean {
  const parsed = ExperienceSessionStorySkillLinkSchema.safeParse(value);
  return parsed.success
    && isExperienceEvidenceRefArray(parsed.data.evidenceRefs);
}

export function isExperienceSessionStoryGraphNode(value: unknown): boolean {
  return ExperienceSessionStoryGraphNodeSchema.safeParse(value).success;
}

export function isExperienceSessionStoryGraphEdge(value: unknown): boolean {
  return ExperienceSessionStoryGraphEdgeSchema.safeParse(value).success;
}

export function isExperienceSessionStoryNode(value: unknown): boolean {
  const parsed = ExperienceSessionStoryNodeSchema.safeParse(value);
  return parsed.success
    && isExperienceEvidenceRefArray(parsed.data.evidenceRefs);
}

export function isExperienceSessionStoryAnswer(value: unknown): boolean {
  const parsed = ExperienceSessionStoryAnswerSchema.safeParse(value);
  return parsed.success
    && isExperienceEvidenceRefArray(parsed.data.evidenceRefs)
    && parsed.data.checklistItems.every(isExperienceChecklistItem);
}

export function isExperienceGoalEvidenceRef(value: unknown): boolean {
  const parsed = ExperienceGoalEvidenceRefSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return (data.evidenceRef === undefined || isExperienceEvidenceRef(data.evidenceRef));
}

export function isExperienceSkillSegment(value: unknown): boolean {
  const parsed = ExperienceSkillSegmentSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return isTimestampRange(data.startTimestamp, data.endTimestamp)
    && isExperienceEvidenceRefArray(data.evidenceRefs)
    && data.typeSpecificChecklist.every(isExperienceChecklistItem)
    && (data.messageRanges === undefined || data.messageRanges.every(
      (range) => range.startMessageIndex <= range.endMessageIndex,
    ))
    && (data.startMessageIndex === undefined || data.endMessageIndex === undefined
      || data.startMessageIndex <= data.endMessageIndex);
}

export function isExperienceOrchestrationEdge(value: unknown): boolean {
  const parsed = ExperienceOrchestrationEdgeSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return isExperienceEvidenceRefArray(data.evidenceRefs)
    && [data.runnerStartedRef, data.runnerCompletedRef, data.notificationRef]
      .every((ref) => ref === undefined || isExperienceEvidenceRef(ref));
}

export function isExperienceFeedbackAttribution(value: unknown): boolean {
  const parsed = ExperienceFeedbackAttributionSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return isExperienceEvidenceRefArray(data.evidenceRefs);
}

export function isExperienceFeedbackSignal(value: unknown): boolean {
  const parsed = ExperienceFeedbackSignalSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return isExperienceEvidenceRef(data.evidenceRef)
    && (data.canonicalAttributions === undefined
      || data.canonicalAttributions.every(isExperienceFeedbackAttribution))
    && data.attributions.every(isExperienceFeedbackAttribution);
}

export function isExperienceEpisodeArtifact(value: unknown): boolean {
  const parsed = ExperienceEpisodeArtifactSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return isExperienceEvidenceRef(data.evidenceRef);
}

export function isExperienceEpisodeOutcome(value: unknown): boolean {
  const parsed = ExperienceEpisodeOutcomeSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return data.artifacts.every(isExperienceEpisodeArtifact);
}

export function isExperienceEpisode(value: unknown): boolean {
  const parsed = ExperienceEpisodeSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return isTimestampRange(data.startTimestamp, data.endTimestamp)
    && data.goalEvidenceRefs.every(isExperienceGoalEvidenceRef)
    && [data.startRef, data.endRef].every((ref) => ref === undefined || isExperienceEvidenceRef(ref))
    && data.skillSegments.every(isExperienceSkillSegment)
    && data.orchestrationEdges.every(isExperienceOrchestrationEdge)
    && data.feedbackSignals.every(isExperienceFeedbackSignal)
    && isExperienceEpisodeOutcome(data.outcome);
}

export function isExperienceStoryContext(value: unknown): value is ExperienceStoryContext {
  const parsed = ExperienceStoryContextSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return data.goalSlices.every(isExperienceSessionStoryGoalSlice)
    && data.subagentDispatches.every(isExperienceSessionStorySubagentDispatch)
    && data.episodes.every(isExperienceEpisode);
}

export function isExperienceSessionStory(value: unknown): boolean {
  if (!isObjectRecord(value)
    || value.goalSlices !== undefined
    || value.subagentDispatches !== undefined
    || value.episodes !== undefined) return false;
  const parsed = ExperienceSessionStoryWireSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return data.skillLinks.every(isExperienceSessionStorySkillLink)
    && data.nodes.every(isExperienceSessionStoryNode)
    && data.answers.every(isExperienceSessionStoryAnswer);
}

export function isExperienceReviewerReportStep(value: unknown): boolean {
  const parsed = ExperienceReviewerReportStepSchema.safeParse(value);
  return parsed.success && isExperienceEvidenceRefArray(parsed.data.evidenceRefs);
}

export function isExperienceReviewerReportFinding(value: unknown): boolean {
  const parsed = ExperienceReviewerReportFindingSchema.safeParse(value);
  return parsed.success
    && isExperienceEvidenceRefArray(parsed.data.evidenceRefs)
    && isOptionalTimestamp(parsed.data.reviewStateRef.reviewedAt);
}

export function isExperienceReviewerMetrics(value: unknown): boolean {
  const parsed = ExperienceReviewerMetricsWireSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  const { observedInvocationCount, invocationCount, coverage } = data.tokenUsage;
  return isRate(coverage)
    && observedInvocationCount <= invocationCount
    && Math.abs(coverage - (invocationCount > 0 ? observedInvocationCount / invocationCount : 1)) <= 0.0001
    && data.toolFailureCount + data.toolCancelledCount + data.toolUnknownCount <= data.toolCallCount;
}

export function isExperienceReviewerReport(value: unknown): boolean {
  if (!isObjectRecord(value) || value.sessionStory !== undefined) return false;
  const parsed = ExperienceReviewerReportWireSchema.safeParse(value);
  if (!parsed.success) return false;
  const data = parsed.data;
  return isTimestamp(data.generatedAt)
    && data.chainSteps.every(isExperienceReviewerReportStep)
    && data.findings.every(isExperienceReviewerReportFinding)
    && isExperienceReviewerMetrics(data.oneLookMetrics)
    && isExperienceEvidenceRefArray(data.traceLinks);
}

// Event validation retains legacy kind coercion and tool-result semantics.
const TimelineTreeShellSchema = ExperienceTimelineTreeSchema.omit({ main: true, branches: true });
const TimelineBranchShellSchema = ExperienceTimelineBranchSchema.omit({ events: true });
const TraceTimelineShellSchema = ExperienceTraceTimelineSchema.omit({ tree: true });
