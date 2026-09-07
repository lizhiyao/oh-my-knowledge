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
  ExperienceEpisodeArtifactKindSchema,
  ExperienceEpisodeBoundaryReasonSchema,
  ExperienceEpisodeRoleSchema,
  ExperienceEvidenceKindSchema,
  ExperienceFeedbackAttributionReasonSchema,
  ExperienceFeedbackAttributionRoleSchema,
  ExperienceFeedbackSignalTypeSchema,
  ExperienceGoalSliceReasonCodeSchema,
  ExperienceOrchestrationEdgeKindSchema,
  ExperienceOrchestrationEdgeStatusSchema,
  ExperienceOutcomeClosureSchema,
  ExperienceParentReasonSchema,
  ExperienceReviewBasisCodeSchema,
  ExperienceReviewPrioritySchema,
  ExperienceReviewerReportFindingLevelSchema,
  ExperienceReviewerReportFindingSourceSchema,
  ExperienceReviewerReportScopeSchema,
  ExperienceReviewerReportStepStatusSchema,
  ExperienceRuntimeSkillTypeSchema,
  ExperienceRuntimeSkillTypeSourceSchema,
  ExperienceSessionStoryAnswerKeySchema,
  ExperienceSessionStoryNodeKindSchema,
  ExperienceSessionStorySkillRoleSchema,
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
  if (values.some((value) => {
    if (
      !isObjectRecord(value)
      || typeof value.id !== 'string'
      || typeof value.sessionGroupKey !== 'string'
      || typeof value.sessionId !== 'string'
      || !isNonNegativeInteger(value.eventCount)
    ) return true;
    return !isTimelineTree(value.tree);
  })) return null;
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
  if (
    !isObjectRecord(value)
    || !isNonNegativeInteger(value.sessionCount)
    || !isNonNegativeInteger(value.skillCount)
    || !isNonNegativeInteger(value.invocationCount)
    || !isNonNegativeInteger(value.goalSliceCount)
  ) return false;
  return isEnumArray(value.noteCodes, [
    'no_llm_judge',
    'no_auto_verdict',
    'default_goal_slice_is_allowed',
    'deterministic_assistive_inference',
  ]);
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
  return isObjectRecord(value)
    && typeof value.source === 'string'
    && isRate(value.confidence)
    && isOptionalString(value.rawSkillRef)
    && isOptionalString(value.pluginName)
    && isOptionalString(value.commandName);
}

export function isExperienceInvocationMetrics(value: unknown): boolean {
  const parsed = ExperienceInvocationMetricsWireSchema.safeParse(value);
  if (!parsed.success) return false;
  const metrics = parsed.data;
  return metrics.numToolFailures + metrics.numToolCancelled + metrics.numToolUnknown
    <= metrics.numToolCalls;
}

export const EXPERIENCE_INDICATOR_KEYS = [
  'userMessageCount',
  'userFollowUpCount',
  'userCorrectionCount',
  'userInterruptionCount',
  'sessionInterruptedCount',
  'negativeFeedbackCount',
  'positiveFeedbackCount',
  'userGoalShiftCount',
  'hardRuleTextHitCount',
  'assistantDeliverySignalCount',
  'deliverableArtifactSignalCount',
  'routerDownstreamCompleted',
  'routerDownstreamFailed',
  'selfCorrectionCount',
  'repeatedExecutionCount',
  'toolCallCount',
  'toolFailureCount',
  'highObservationCount',
  'mediumObservationCount',
  'hedgingCount',
  'explicitMarkerCount',
] as const;

export function isExperienceIndicators(value: unknown): boolean {
  return isObjectRecord(value)
    && EXPERIENCE_INDICATOR_KEYS.every((key) => isNonNegativeInteger(value[key]))
    && (
      isNonNegativeInteger(value.toolCancelledCount)
      && isNonNegativeInteger(value.toolUnknownCount)
    )
    && (value.toolCancelledCount === undefined || isNonNegativeInteger(value.toolCancelledCount))
    && (value.toolUnknownCount === undefined || isNonNegativeInteger(value.toolUnknownCount))
    && (value.toolFailureCount as number)
      + (typeof value.toolCancelledCount === 'number' ? value.toolCancelledCount : 0)
      + (typeof value.toolUnknownCount === 'number' ? value.toolUnknownCount : 0)
      <= (value.toolCallCount as number);
}

export function isCountRecord(value: unknown): boolean {
  return isObjectRecord(value)
    && Object.values(value).every(isNonNegativeInteger);
}

export function isExperienceTimelineScope(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || value.mode !== 'skill_segment_window'
    || !isNonNegativeInteger(value.segmentEventCount)
    || !isNonNegativeInteger(value.previewEventCount)
    || !isNonNegativeInteger(value.fullSessionEventCount)
    || !isExperienceTraceRecordRangeArray(value.segmentRecordRanges)
    || !isExperienceTraceRecordRangeArray(value.previewRecordRanges)
    || !isExperienceTraceRecordRangeArray(value.sessionRecordRanges)
    || typeof value.truncated !== 'boolean'
    || !isNonNegativeInteger(value.omittedBeforeCount)
    || !isNonNegativeInteger(value.omittedAfterCount)
  ) return false;
  return value.previewEventCount <= value.segmentEventCount
    && value.segmentEventCount <= value.fullSessionEventCount
    && value.omittedBeforeCount + value.omittedAfterCount <= value.fullSessionEventCount;
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
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || !isEnumValue(String(value.kind), ExperienceEvidenceKindSchema.options)
    || typeof value.sourceTrace !== 'string'
    || typeof value.sessionId !== 'string'
    || !isNonNegativeInteger(value.order)
  ) return false;
  const optionalIndexes = [
    value.messageIndex,
    value.logicalMessageIndex,
    value.sourceLineIndex,
  ];
  if (!optionalIndexes.every((index) => index === undefined || isNonNegativeInteger(index))) return false;
  if (
    value.traceRole !== undefined
    && value.traceRole !== 'standalone'
    && value.traceRole !== 'main'
    && value.traceRole !== 'subagent'
  ) return false;
  if (
    value.role !== undefined
    && value.role !== 'user'
    && value.role !== 'assistant'
    && value.role !== 'tool'
    && value.role !== 'other'
  ) return false;
  if (
    value.toolStatus !== undefined
    && value.toolStatus !== 'success'
    && value.toolStatus !== 'failure'
    && value.toolStatus !== 'cancelled'
    && value.toolStatus !== 'unknown'
  ) return false;
  if (value.modelActivityKind !== undefined && value.modelActivityKind !== 'reasoning') return false;
  if (
    value.contentVisibility !== undefined
    && value.contentVisibility !== 'plaintext'
    && value.contentVisibility !== 'opaque'
  ) return false;
  if (
    value.contentSource !== undefined
    && value.contentSource !== 'summary'
    && value.contentSource !== 'content'
    && value.contentSource !== 'text'
  ) return false;
  if (
    value.runtimeKind !== undefined
    && value.runtimeKind !== 'session_context'
    && value.runtimeKind !== 'execution_context'
    && value.runtimeKind !== 'settings'
    && value.runtimeKind !== 'goal'
    && value.runtimeKind !== 'context_compaction'
    && value.runtimeKind !== 'usage'
  ) return false;
  const optionalStrings = [
    value.traceId,
    value.traceLabel,
    value.turnId,
    value.messageUuid,
    value.sourceType,
    value.model,
    value.callInstanceId,
    value.toolUseId,
    value.label,
    value.snippet,
    value.toolName,
    value.fullText,
  ];
  if (
    !optionalStrings.every((field) => field === undefined || typeof field === 'string')
    || !isOptionalTimestamp(value.timestamp)
    || (value.isError !== undefined && typeof value.isError !== 'boolean')
    || (value.attachments !== undefined && !isTimelineAttachmentArray(value.attachments))
  ) return false;
  return value.kind !== 'tool_result'
    || value.toolStatus === undefined
    || value.isError === undefined
    || value.isError === (value.toolStatus === 'failure');
}

export function isTimelineAttachmentArray(value: unknown): value is NonNullable<ExperienceTimelineEvent['attachments']> {
  return Array.isArray(value) && value.every((attachment) => (
    isObjectRecord(attachment)
    && (attachment.attachmentKind === 'image' || attachment.attachmentKind === 'file')
    && typeof attachment.name === 'string'
    && attachment.name.length > 0
  ));
}

export function isTimelineEventArray(value: unknown): value is ExperienceTimelineEvent[] {
  return Array.isArray(value) && value.every(isTimelineEvent);
}

export function isExperienceTurnSummaryArray(value: unknown): value is ExperienceTurnSummary[] {
  return Array.isArray(value) && value.every((turn) => (
    isObjectRecord(turn)
    && typeof turn.turnId === 'string'
    && isOptionalString(turn.sourceTurnId)
    && (
      turn.boundaryBasis === 'turn_id'
      || turn.boundaryBasis === 'turn_lifecycle'
      || turn.boundaryBasis === 'user_message'
    )
    && isOptionalString(turn.traceId)
    && typeof turn.sourceTrace === 'string'
    && isOptionalTimestamp(turn.startTimestamp)
    && isOptionalTimestamp(turn.endTimestamp)
    && (
      turn.status === 'completed'
      || turn.status === 'failed'
      || turn.status === 'aborted'
      || turn.status === 'interrupted'
      || turn.status === 'open'
      || turn.status === 'unknown'
    )
    && typeof turn.title === 'string'
    && isStringArray(turn.eventIds)
    && isNonNegativeInteger(turn.userMessageCount)
    && isNonNegativeInteger(turn.assistantMessageCount)
    && isNonNegativeInteger(turn.toolCallCount)
    && isNonNegativeInteger(turn.toolFailureCount)
  ));
}

export function isTimelineTree(value: unknown): value is ExperienceTimelineTree {
  if (
    !isObjectRecord(value)
    || typeof value.sessionId !== 'string'
    || !isTimelineEventArray(value.main)
    || !Array.isArray(value.branches)
  ) return false;
  return value.branches.every((branch) => {
    if (
      !isObjectRecord(branch)
      || typeof branch.id !== 'string'
      || typeof branch.label !== 'string'
      || typeof branch.sessionId !== 'string'
      || !isOptionalString(branch.traceId)
      || typeof branch.sourceTrace !== 'string'
      || (
        branch.traceRole !== 'main'
        && branch.traceRole !== 'subagent'
        && branch.traceRole !== 'standalone'
      )
      || !isTimelineEventArray(branch.events)
    ) return false;
    if (branch.attachTo === undefined) return true;
    if (
      !isObjectRecord(branch.attachTo)
      || !isOptionalString(branch.attachTo.traceId)
      || typeof branch.attachTo.sourceTrace !== 'string'
    ) return false;
    return (branch.attachTo.messageIndex === undefined || isNonNegativeInteger(branch.attachTo.messageIndex))
      && (branch.attachTo.callInstanceId === undefined || typeof branch.attachTo.callInstanceId === 'string')
      && (branch.attachTo.toolUseId === undefined || typeof branch.attachTo.toolUseId === 'string')
      && (branch.attachTo.label === undefined || typeof branch.attachTo.label === 'string');
  });
}

export function isExperienceChecklistItem(value: unknown): boolean {
  const parsed = ExperienceChecklistItemSchema.safeParse(value);
  return parsed.success && isExperienceEvidenceRefArray(parsed.data.evidenceRefs);
}

export function isExperienceSessionStoryGoalSlice(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isNonNegativeInteger(value.order)
    && isStringArray(value.skillNames)
    && isTimestampRange(value.startTimestamp, value.endTimestamp)
    && isEnumValue(value.reasonCode, ExperienceGoalSliceReasonCodeSchema.options)
    && isOptionalString(value.inferredUserGoal)
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

export function isExperienceSessionStorySubagentDispatch(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || !isNonNegativeInteger(value.order)
    || typeof value.branchId !== 'string'
    || typeof value.childSessionId !== 'string'
    || typeof value.traceId !== 'string'
    || typeof value.label !== 'string'
    || typeof value.sourceTrace !== 'string'
    || !isNonNegativeInteger(value.eventCount)
    || !isExperienceEvidenceRefArray(value.evidenceRefs)
  ) return false;
  if (value.attachTo === undefined) return true;
  return isObjectRecord(value.attachTo)
    && isOptionalNonNegativeInteger(value.attachTo.messageIndex)
    && isOptionalString(value.attachTo.callInstanceId)
    && isOptionalString(value.attachTo.toolUseId)
    && isOptionalString(value.attachTo.label);
}

export function isExperienceSessionStorySkillLink(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isNonNegativeInteger(value.order)
    && typeof value.skillName === 'string'
    && isEnumValue(value.role, ExperienceSessionStorySkillRoleSchema.options)
    && isStringArray(value.invocationIds)
    && isStringArray(value.goalSliceIds)
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

export function isExperienceSessionStoryGraphNode(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && isEnumValue(value.kind, ExperienceSessionStoryNodeKindSchema.options)
    && isEnumValue(value.status, ExperienceReviewerReportStepStatusSchema.options)
    && (value.role === undefined || isEnumValue(value.role, ExperienceSessionStorySkillRoleSchema.options))
    && isOptionalString(value.detailNodeId);
}

export function isExperienceSessionStoryGraphEdge(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.fromId === 'string'
    && typeof value.toId === 'string'
    && typeof value.label === 'string';
}

export function isExperienceSessionStoryNode(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isNonNegativeInteger(value.order)
    && isEnumValue(value.kind, ExperienceSessionStoryNodeKindSchema.options)
    && typeof value.label === 'string'
    && isEnumValue(value.status, ExperienceReviewerReportStepStatusSchema.options)
    && typeof value.text === 'string'
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

export function isExperienceSessionStoryAnswer(value: unknown): boolean {
  return isObjectRecord(value)
    && isEnumValue(value.key, ExperienceSessionStoryAnswerKeySchema.options)
    && typeof value.label === 'string'
    && isEnumValue(value.status, ExperienceReviewerReportStepStatusSchema.options)
    && isEnumValue(value.reason, ExperienceParentReasonSchema.options)
    && isStringArray(value.sourceItemKeys)
    && typeof value.text === 'string'
    && isExperienceEvidenceRefArray(value.evidenceRefs)
    && Array.isArray(value.checklistItems)
    && value.checklistItems.every(isExperienceChecklistItem);
}

export function isExperienceGoalEvidenceRef(value: unknown): boolean {
  return isObjectRecord(value)
    && isEnumValue(value.kind, ['user_message', 'goal_slice', 'llm_goal'])
    && isOptionalString(value.goalSliceId)
    && (value.evidenceRef === undefined || isExperienceEvidenceRef(value.evidenceRef))
    && isOptionalString(value.label);
}

export function isExperienceSkillSegment(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || !isNonNegativeInteger(value.order)
    || typeof value.skillName !== 'string'
    || !isEnumValue(value.skillType, ExperienceRuntimeSkillTypeSchema.options)
    || (
      value.skillTypeSource !== undefined
      && !isEnumValue(value.skillTypeSource, ExperienceRuntimeSkillTypeSourceSchema.options)
    )
    || (
      value.declaredSkillType !== undefined
      && !isEnumValue(value.declaredSkillType, ExperienceRuntimeSkillTypeSchema.options)
    )
    || (
      value.traceInferredSkillType !== undefined
      && !isEnumValue(value.traceInferredSkillType, ExperienceRuntimeSkillTypeSchema.options)
    )
    || !isEnumValue(value.episodeRole, ExperienceEpisodeRoleSchema.options)
    || !isStringArray(value.skillInvocationIds)
    || !isOptionalNonNegativeInteger(value.startMessageIndex)
    || !isOptionalNonNegativeInteger(value.endMessageIndex)
    || !isTimestampRange(value.startTimestamp, value.endTimestamp)
    || !Array.isArray(value.typeSpecificChecklist)
    || !value.typeSpecificChecklist.every(isExperienceChecklistItem)
    || !isExperienceEvidenceRefArray(value.evidenceRefs)
  ) return false;
  if (
    value.messageRanges !== undefined
    && (
      !Array.isArray(value.messageRanges)
      || value.messageRanges.some((range) =>
        !isObjectRecord(range)
        || !isNonNegativeInteger(range.startMessageIndex)
        || !isNonNegativeInteger(range.endMessageIndex)
        || range.startMessageIndex > range.endMessageIndex
        || !isOptionalString(range.traceId)
        || !isOptionalString(range.sourceTrace)
        || !isOptionalString(range.sessionId)
      )
    )
  ) return false;
  if (
    typeof value.startMessageIndex === 'number'
    && typeof value.endMessageIndex === 'number'
    && value.startMessageIndex > value.endMessageIndex
  ) return false;
  if (value.runtimeAssessment === undefined) return true;
  return isObjectRecord(value.runtimeAssessment)
    && isOptionalString(value.runtimeAssessment.goalSatisfaction)
    && isOptionalString(value.runtimeAssessment.declaredBehaviorFit)
    && isOptionalString(value.runtimeAssessment.artifactGoalMatch)
    && isOptionalString(value.runtimeAssessment.userFeeling);
}

export function isExperienceOrchestrationEdge(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && typeof value.episodeId === 'string'
    && isEnumValue(value.edgeKind, ExperienceOrchestrationEdgeKindSchema.options)
    && isOptionalString(value.parentSkillSegmentId)
    && isOptionalString(value.executorSkillSegmentId)
    && isOptionalString(value.childSessionId)
    && (value.runnerStartedRef === undefined || isExperienceEvidenceRef(value.runnerStartedRef))
    && (value.runnerCompletedRef === undefined || isExperienceEvidenceRef(value.runnerCompletedRef))
    && (value.notificationRef === undefined || isExperienceEvidenceRef(value.notificationRef))
    && isEnumValue(value.status, ExperienceOrchestrationEdgeStatusSchema.options)
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

export function isExperienceFeedbackAttribution(value: unknown): boolean {
  return isObjectRecord(value)
    && isOptionalString(value.skillName)
    && isOptionalString(value.skillSegmentId)
    && isEnumValue(value.attributionRole, ExperienceFeedbackAttributionRoleSchema.options)
    && isEnumValue(value.reasonCode, ExperienceFeedbackAttributionReasonSchema.options)
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

export function isExperienceFeedbackSignal(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isNonNegativeInteger(value.order)
    && isEnumValue(value.type, ExperienceFeedbackSignalTypeSchema.options)
    && typeof value.text === 'string'
    && isOptionalString(value.targetObject)
    && isEnumValue(value.sourceWindow, [
      'session',
      'episode',
      'skill_invocation',
      'downstream_child',
    ])
    && isExperienceEvidenceRef(value.evidenceRef)
    && (
      value.canonicalAttributions === undefined
      || (
        Array.isArray(value.canonicalAttributions)
        && value.canonicalAttributions.every(isExperienceFeedbackAttribution)
      )
    )
    && Array.isArray(value.attributions)
    && value.attributions.every(isExperienceFeedbackAttribution);
}

export function isExperienceEpisodeArtifact(value: unknown): boolean {
  return isObjectRecord(value)
    && isEnumValue(value.kind, ExperienceEpisodeArtifactKindSchema.options)
    && typeof value.label === 'string'
    && isOptionalString(value.pathOrUrl)
    && isEnumValue(value.artifactGoalMatch, ['passed', 'failed', 'unknown'])
    && isExperienceEvidenceRef(value.evidenceRef);
}

export function isExperienceEpisodeOutcome(value: unknown): boolean {
  return isObjectRecord(value)
    && isEnumValue(value.closure, ExperienceOutcomeClosureSchema.options)
    && Array.isArray(value.artifacts)
    && value.artifacts.every(isExperienceEpisodeArtifact)
    && isExperienceReviewPriority(value.verdict)
    && isOptionalString(value.acceptanceCriteria);
}

export function isExperienceEpisode(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isNonNegativeInteger(value.order)
    && typeof value.sessionId === 'string'
    && isOptionalString(value.primaryGoal)
    && Array.isArray(value.goalEvidenceRefs)
    && value.goalEvidenceRefs.every(isExperienceGoalEvidenceRef)
    && isTimestampRange(value.startTimestamp, value.endTimestamp)
    && (value.startRef === undefined || isExperienceEvidenceRef(value.startRef))
    && (value.endRef === undefined || isExperienceEvidenceRef(value.endRef))
    && isEnumValue(value.boundaryReason, ExperienceEpisodeBoundaryReasonSchema.options)
    && Array.isArray(value.skillSegments)
    && value.skillSegments.every(isExperienceSkillSegment)
    && Array.isArray(value.orchestrationEdges)
    && value.orchestrationEdges.every(isExperienceOrchestrationEdge)
    && Array.isArray(value.feedbackSignals)
    && value.feedbackSignals.every(isExperienceFeedbackSignal)
    && isExperienceEpisodeOutcome(value.outcome);
}

export function isExperienceStoryContext(value: unknown): value is ExperienceStoryContext {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && typeof value.sessionGroupKey === 'string'
    && Array.isArray(value.goalSlices)
    && value.goalSlices.every(isExperienceSessionStoryGoalSlice)
    && Array.isArray(value.subagentDispatches)
    && value.subagentDispatches.every(isExperienceSessionStorySubagentDispatch)
    && Array.isArray(value.episodes)
    && value.episodes.every(isExperienceEpisode);
}

export function isExperienceSessionStory(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || value.schemaVersion !== 1
    || typeof value.contextRef !== 'string'
    || typeof value.summary !== 'string'
    || !isNonNegativeInteger(value.invocationCount)
    || !isNonNegativeInteger(value.goalSliceCount)
    || !isNonNegativeInteger(value.branchCount)
    || !isNonNegativeInteger(value.progressUpdateCount)
    || !isNonNegativeInteger(value.finalDeliverySignalCount)
    || !isStringArray(value.mainlineNodeIds)
    || !Array.isArray(value.skillLinks)
    || !value.skillLinks.every(isExperienceSessionStorySkillLink)
    || !isObjectRecord(value.graph)
    || !Array.isArray(value.graph.nodes)
    || !value.graph.nodes.every(isExperienceSessionStoryGraphNode)
    || !Array.isArray(value.graph.edges)
    || !value.graph.edges.every(isExperienceSessionStoryGraphEdge)
    || !Array.isArray(value.nodes)
    || !value.nodes.every(isExperienceSessionStoryNode)
    || !Array.isArray(value.answers)
    || !value.answers.every(isExperienceSessionStoryAnswer)
  ) return false;
  return value.goalSlices === undefined
    && value.subagentDispatches === undefined
    && value.episodes === undefined;
}

export function isExperienceReviewerReportStep(value: unknown): boolean {
  return isObjectRecord(value)
    && isNonNegativeInteger(value.order)
    && typeof value.label === 'string'
    && isEnumValue(value.status, ExperienceReviewerReportStepStatusSchema.options)
    && typeof value.text === 'string'
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

export function isExperienceReviewerReportFinding(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || typeof value.judgmentId !== 'string'
    || !isEnumValue(value.source, ExperienceReviewerReportFindingSourceSchema.options)
    || !isEnumValue(value.level, ExperienceReviewerReportFindingLevelSchema.options)
    || typeof value.title !== 'string'
    || typeof value.body !== 'string'
    || typeof value.ruleSource !== 'string'
    || typeof value.ruleVersion !== 'string'
    || !isExperienceEvidenceRefArray(value.evidenceRefs)
    || !isObjectRecord(value.reviewStateRef)
    || value.reviewStateRef.targetType !== 'reviewer_judgment'
    || typeof value.reviewStateRef.targetId !== 'string'
  ) return false;
  return [
    value.reviewStateRef.verdict,
    value.reviewStateRef.reason,
    value.reviewStateRef.note,
  ].every(isOptionalString)
    && isOptionalTimestamp(value.reviewStateRef.reviewedAt);
}

export function isExperienceReviewerMetrics(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  const countKeys = [
    'toolCallCount',
    'toolFailureCount',
    'userMessageCount',
    'userFollowUpCount',
    'assistantDeliverySignalCount',
    'deliverableArtifactSignalCount',
    'routerDownstreamCompleted',
    'routerDownstreamFailed',
    'assistantProgressUpdateCount',
    'selfCorrectionCount',
    'repeatedExecutionCount',
    'finalDeliverySignalCount',
    'traceEventCount',
  ];
  if (
    !countKeys.every((key) => isNonNegativeInteger(value[key]))
    || (
      !isNonNegativeInteger(value.toolCancelledCount)
      || !isNonNegativeInteger(value.toolUnknownCount)
    )
    || (
      value.toolCancelledCount !== undefined
      && !isNonNegativeInteger(value.toolCancelledCount)
    )
    || (
      value.toolUnknownCount !== undefined
      && !isNonNegativeInteger(value.toolUnknownCount)
    )
    || !isObjectRecord(value.tokenUsage)
  ) return false;
  const tokenKeys = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
  ];
  const tokenUsage = value.tokenUsage as Record<string, unknown>;
  const observedInvocationCount = tokenUsage.observedInvocationCount;
  const invocationCount = tokenUsage.invocationCount;
  const coverage = tokenUsage.coverage;
  const hasCoverage = observedInvocationCount !== undefined
    || invocationCount !== undefined
    || coverage !== undefined;
  return tokenKeys.every((key) => isNonNegativeInteger(tokenUsage[key]))
    && tokenUsage.attribution === 'skill_segment'
    && (
      !hasCoverage
      || (
        isNonNegativeInteger(observedInvocationCount)
        && isNonNegativeInteger(invocationCount)
        && isRate(coverage)
        && (observedInvocationCount as number) <= (invocationCount as number)
        && Math.abs(
          (coverage as number)
          - (
            (invocationCount as number) > 0
              ? (observedInvocationCount as number) / (invocationCount as number)
              : 1
          ),
        ) <= 0.0001
      )
    )
    && hasCoverage
    && (value.toolFailureCount as number)
      + (typeof value.toolCancelledCount === 'number' ? value.toolCancelledCount : 0)
      + (typeof value.toolUnknownCount === 'number' ? value.toolUnknownCount : 0)
      <= (value.toolCallCount as number);
}

export function isExperienceReviewerReport(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || value.schemaVersion !== 1
    || !isEnumValue(value.mode, ['deterministic_milestone_1', 'deterministic_session_story'])
    || !isTimestamp(value.generatedAt)
    || typeof value.title !== 'string'
    || typeof value.summary !== 'string'
    || !isObjectRecord(value.scope)
    || !isEnumValue(value.scope.kind, ExperienceReviewerReportScopeSchema.options)
    || !isStringArray(value.scope.reasonCodes)
    || !Array.isArray(value.chainSteps)
    || !value.chainSteps.every(isExperienceReviewerReportStep)
    || !Array.isArray(value.findings)
    || !value.findings.every(isExperienceReviewerReportFinding)
    || !isExperienceReviewerMetrics(value.oneLookMetrics)
    || !isStringArray(value.authorSuggestions)
    || !isExperienceEvidenceRefArray(value.traceLinks)
  ) return false;
  return value.sessionStory === undefined && value.sessionStoryRef === 'session';
}
