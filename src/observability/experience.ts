import { createHash } from 'node:crypto';
import type { ObservationInboxItem, ObservationSourceKind } from './inbox.js';
import {
  buildExperienceProblemPatterns,
  mergeExperienceProblemPatterns,
  type ExperienceProblemPattern,
} from './problem-patterns.js';
import { observationMetricAnnotationVerdict, type ObservationMetricKey, type ObservationReviewState } from './review-state.js';
import type { CcAssistantRecord, CcRecord, CcSession, CcUserRecord, TraceSourceMetadata } from './trace-source.js';
import type { SkillSegment } from './trace-segmenter.js';
import { extractCommandEnvelopeText, stripCommandEnvelopeText } from './trace-attribution.js';
import { hasAssistantDeliverySignalText, hasUserHardRuleText, isScheduledTaskPromptText } from './text-signals.js';
import { durationMsBetween } from '../shared/time.js';

export type ExperienceReviewPriority = 'review_first' | 'sample_review' | 'routine_sample';
export type ExperienceGoalSliceReasonCode = 'skill_segment_boundary' | 'explicit_user_goal_shift' | 'default_session_slice';
export type ExperienceEvidenceKind = 'user_message' | 'assistant_message' | 'tool_use' | 'tool_result' | 'skill_context' | 'runtime_context' | 'observation';
export type ExperienceAssistiveInferenceCode =
  | 'review_recommended'
  | 'sample_recommended'
  | 'positive_signal_observed'
  | 'user_switched_topic_neutral'
  | 'no_obvious_issue_from_rules'
  | 'insufficient_human_context';
export type ExperienceAssistiveInferenceConfidence = 'low' | 'medium' | 'high';
export type ExperienceAssistiveInferenceCautionCode =
  | 'no_llm_judge'
  | 'rule_only'
  | 'runtime_context_excluded'
  | 'skill_context_excluded'
  | 'no_human_user_message'
  | 'limited_timeline_window';
export type ExperienceReviewBasisCode =
  | 'has_high_observation'
  | 'has_medium_observation'
  | 'user_correction'
  | 'user_interruption'
  | 'negative_feedback'
  | 'hard_rule_text_hit'
  | 'tool_failure'
  | 'hedging_signal'
  | 'explicit_marker';
export type ExperienceRuleFindingLevel = 'attention' | 'sample' | 'normal';
export type ExperienceRuleFindingCode =
  | 'high_observation_seen'
  | 'medium_observation_seen'
  | 'user_correction_seen'
  | 'user_interruption_seen'
  | 'negative_feedback_seen'
  | 'positive_feedback_seen'
  | 'user_goal_shift_seen'
  | 'hard_rule_seen'
  | 'tool_failure_seen'
  | 'hedging_seen'
  | 'explicit_marker_seen'
  | 'runtime_context_excluded'
  | 'skill_context_excluded'
  | 'no_priority_signal';

export interface ExperienceEvidenceRef {
  id: string;
  kind: ExperienceEvidenceKind;
  sourceTrace: string;
  sessionId: string;
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
  messageIndex?: number;
  messageUuid?: string;
  toolUseId?: string;
  timestamp?: string;
  role?: 'user' | 'assistant' | 'tool' | 'other';
  label?: string;
  snippet?: string;
}

export interface ExperienceTimelineEvent extends ExperienceEvidenceRef {
  order: number;
  toolName?: string;
  isError?: boolean;
  fullText?: string;
}

export interface ExperienceTimelineBranch {
  id: string;
  label: string;
  sourceTrace: string;
  traceRole: 'main' | 'subagent' | 'standalone';
  attachTo?: {
    sourceTrace: string;
    messageIndex?: number;
    toolUseId?: string;
    label?: string;
  };
  events: ExperienceTimelineEvent[];
}

export interface ExperienceTimelineTree {
  sessionId: string;
  main: ExperienceTimelineEvent[];
  branches: ExperienceTimelineBranch[];
}

export interface ExperienceEvidenceChain {
  userMessageCount: number;
  runtimeContextCount: number;
  skillContextCount: number;
  assistantMessageCount: number;
  toolUseCount: number;
  toolResultCount: number;
  toolFailureResultCount: number;
  observationCount: number;
  firstUserMessage?: ExperienceEvidenceRef;
  firstRuntimeContext?: ExperienceEvidenceRef;
  firstSkillContext?: ExperienceEvidenceRef;
  firstToolUse?: ExperienceEvidenceRef;
  firstToolFailure?: ExperienceEvidenceRef;
  lastAssistantMessage?: ExperienceEvidenceRef;
}

export interface ExperienceRuleFinding {
  code: ExperienceRuleFindingCode;
  level: ExperienceRuleFindingLevel;
  count: number;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceAssistiveInference {
  mode: 'deterministic_rules_only';
  code: ExperienceAssistiveInferenceCode;
  confidence: ExperienceAssistiveInferenceConfidence;
  basisRuleCodes: ExperienceRuleFindingCode[];
  cautionCodes: ExperienceAssistiveInferenceCautionCode[];
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceGoalSlice {
  id: string;
  skillName: string;
  sessionId: string;
  sourceTrace: string;
  cwd?: string;
  startTimestamp: string;
  endTimestamp: string;
  sliceReasonCode: ExperienceGoalSliceReasonCode;
  sliceConfidence: 'low' | 'medium' | 'high';
  inferredUserGoal?: string;
  userMessageRefs: ExperienceEvidenceRef[];
}

export interface ExperienceReviewIndicators {
  userMessageCount: number;
  userFollowUpCount: number;
  userCorrectionCount: number;
  userInterruptionCount: number;
  negativeFeedbackCount: number;
  positiveFeedbackCount: number;
  userGoalShiftCount: number;
  hardRuleTextHitCount: number;
  assistantDeliverySignalCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  highObservationCount: number;
  mediumObservationCount: number;
  hedgingCount: number;
  explicitMarkerCount: number;
}

export interface ExperienceInvocation {
  id: string;
  skillName: string;
  sessionId: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
  entrypoint?: string;
  sourceMetadata?: TraceSourceMetadata;
  cwd?: string;
  segmentIndex: number;
  goalSliceId: string;
  startTimestamp: string;
  endTimestamp: string;
  attribution: {
    source: string;
    confidence: number;
    rawSkillRef?: string;
    pluginName?: string;
    commandName?: string;
  };
  metrics: SkillSegment['metrics'];
  toolCounts: Record<string, number>;
  indicators: ExperienceReviewIndicators;
  evidenceChain: ExperienceEvidenceChain;
  ruleFindings: ExperienceRuleFinding[];
  assistiveInference: ExperienceAssistiveInference;
  problemPatterns: ExperienceProblemPattern[];
  relatedObservationIds: string[];
  evidenceRefs: ExperienceEvidenceRef[];
  timeline: ExperienceTimelineEvent[];
}

export interface ExperienceSessionSummary {
  id: string;
  skillName: string;
  sessionId: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
  entrypoint?: string;
  sourceMetadata?: TraceSourceMetadata;
  cwd?: string;
  sourceSessionStartTimestamp?: string;
  sourceSessionEndTimestamp?: string;
  sourceSessionDurationMs?: number;
  startTimestamp: string;
  endTimestamp: string;
  invocationIds: string[];
  goalSliceIds: string[];
  reviewPriority: ExperienceReviewPriority;
  reviewPriorityScore: number;
  reviewBasisCodes: ExperienceReviewBasisCode[];
  indicators: ExperienceReviewIndicators;
  evidenceChain: ExperienceEvidenceChain;
  ruleFindings: ExperienceRuleFinding[];
  assistiveInference: ExperienceAssistiveInference;
  problemPatterns: ExperienceProblemPattern[];
  relatedObservationIds: string[];
  timelinePreview: ExperienceTimelineEvent[];
  fullSessionTimeline: ExperienceTimelineEvent[];
  timelineTree?: ExperienceTimelineTree;
  timelineScope: {
    mode: 'skill_segment_window';
    segmentStartRecordIndex?: number;
    segmentEndRecordIndex?: number;
    previewStartRecordIndex?: number;
    previewEndRecordIndex?: number;
    sessionStartRecordIndex: number;
    sessionEndRecordIndex: number;
    previewEventCount: number;
    fullSessionEventCount: number;
    truncated: boolean;
    omittedBeforeCount: number;
    omittedAfterCount: number;
  };
  attributionSources: string[];
  pluginNames: string[];
  rawSkillRefs: string[];
  commandNames: string[];
}

export interface ExperienceSkillSummary {
  skillName: string;
  invocationCount: number;
  sessionCount: number;
  sourceKinds: ObservationSourceKind[];
  entrypoints: string[];
  entrypointCounts: Record<string, number>;
  sourceMetadataCounts: {
    channels: Record<string, number>;
    senders: Record<string, number>;
    aimaCommands: Record<string, number>;
    providers: Record<string, number>;
    models: Record<string, number>;
  };
  attributionCounts: Record<string, number>;
  pluginNames: string[];
  rawSkillRefs: string[];
  commandNames: string[];
  toolCounts: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
  reviewFirstSessionCount: number;
  sampleReviewSessionCount: number;
  indicators: ExperienceReviewIndicators;
  evidenceChain: ExperienceEvidenceChain;
  ruleFindings: ExperienceRuleFinding[];
  assistiveInference: ExperienceAssistiveInference;
  problemPatterns: ExperienceProblemPattern[];
  relatedObservationIds: string[];
}

export interface ObservationExperienceReport {
  kind: 'observe-experience';
  schemaVersion: 1;
  scope: 'evidence-only';
  generatedAt: string;
  meta: {
    sessionCount: number;
    skillCount: number;
    invocationCount: number;
    goalSliceCount: number;
    noteCodes: Array<'no_llm_judge' | 'no_auto_verdict' | 'default_goal_slice_is_allowed' | 'deterministic_assistive_inference'>;
  };
  goalSlices: ExperienceGoalSlice[];
  invocations: ExperienceInvocation[];
  sessions: ExperienceSessionSummary[];
  skills: ExperienceSkillSummary[];
}

export interface TextMatchRange {
  start: number;
  end: number;
}

const TEXT_BOUNDARY_CHARS = new Set([
  ' ', '\n', '\r', '\t',
  ',', '，', ';', '；', '、', '.', '。', '!', '！', '?', '？', ':', '：',
  '"', "'", '“', '”', '‘', '’', '(', ')', '[', ']', '{', '}', '<', '>', '《', '》',
]);
const BOUNDED_USER_CORRECTION_TERMS = ['不对', '不是', '错了'];
const PHRASE_USER_CORRECTION_TERMS = [
  '不是这个',
  '不要这样',
  '理解错',
  '看错',
  '你应该',
  '应该是',
  '直接用',
  '直接按',
  '改成',
  '重来',
];
const USER_GOAL_SHIFT_TERMS = [
  '换个方向',
  '重新来',
  '重来',
  '先不',
  '不用这个',
  '先不用',
  '暂时不用',
  '不看这个',
  '换一个',
  '换下一个',
  '另一个问题',
  '另外一个问题',
  '先看别的',
  '先处理别的',
];
const NEGATIVE_FEEDBACK_TERMS = [
  '没有用',
  '没用',
  '不行',
  '太慢',
  '看不懂',
  '不需要',
  '别再',
  '怎么又',
  '赶紧',
  '有问题',
  '不符合',
  '做错了',
  '做错',
  '完全错',
  '错得离谱',
  '很垃圾',
  '太垃圾',
  '乱来',
  '瞎搞',
  '白干',
  '浪费时间',
  '没有价值',
  '没价值',
  '没意义',
  '不好用',
  '用不了',
  '没有帮助',
  '没帮助',
  '毫无帮助',
  '太菜',
  '很菜',
  '真菜',
  '菜了',
  '菜啊',
];
const BOUNDED_NEGATIVE_FEEDBACK_TERMS = ['失败', '垃圾', '菜'];
const POSITIVE_FEEDBACK_TERMS = [
  '非常好',
  '很好',
  '做得好',
  '做的好',
  '做得不错',
  '做的不错',
  '不错',
  '很棒',
  '优秀',
  '厉害',
  '很厉害',
  '值得鼓励',
  '很有用',
  '非常有用',
  '很有价值',
  '非常有价值',
  '很有帮助',
  '非常有帮助',
  'good job',
  'great job',
  'well done',
  'nice work',
  'excellent',
  'awesome',
];
const USER_INTERRUPTION_RE = /\[Request interrupted by user(?: for tool use)?\]|interrupted by user|用户中断/i;
const TIMELINE_PREVIEW_EVENT_LIMIT = 240;

interface BuildExperienceInput {
  sessions: CcSession[];
  segments: SkillSegment[];
  items: ObservationInboxItem[];
  generatedAt: string;
  reviewState?: ObservationReviewState;
}

const ZERO_INDICATORS: ExperienceReviewIndicators = {
  userMessageCount: 0,
  userFollowUpCount: 0,
  userCorrectionCount: 0,
  userInterruptionCount: 0,
  negativeFeedbackCount: 0,
  positiveFeedbackCount: 0,
  userGoalShiftCount: 0,
  hardRuleTextHitCount: 0,
  assistantDeliverySignalCount: 0,
  toolCallCount: 0,
  toolFailureCount: 0,
  highObservationCount: 0,
  mediumObservationCount: 0,
  hedgingCount: 0,
  explicitMarkerCount: 0,
};

export function buildObservationExperienceReport(input: BuildExperienceInput): ObservationExperienceReport {
  const sessionsBySourceTrace = new Map(input.sessions.map((session) => [session.sourcePath, session]));
  const sessionGroupsById = groupSessionsByLogicalId(input.sessions);
  const goalSlices: ExperienceGoalSlice[] = [];
  const invocations: ExperienceInvocation[] = [];

  for (const segment of input.segments) {
    if (segment.skillName === 'general') continue;
    const session = sessionsBySourceTrace.get(segment.sourceTrace ?? '') ?? sessionGroupsById.get(segment.sessionId)?.[0];
    const sourceTrace = segment.sourceTrace ?? session?.sourcePath ?? '';
    const relatedItems = relatedObservationItems(segment, input.items);
    const bounds = session ? segmentRecordBounds(session, segment) : { start: 0, end: 0 };
    const timeline = session ? buildTimeline(session, bounds.start, bounds.end) : [];
    const userRefs = timeline.filter((event) => event.kind === 'user_message');
    const indicators = indicatorsForSegment(segment, relatedItems, timeline, input.reviewState);
    const observationRefs = relatedItems.map(observationEvidenceRef);
    const evidenceChain = evidenceChainForTimeline(timeline, observationRefs);
    const ruleFindings = ruleFindingsForEvidence(indicators, timeline, observationRefs, evidenceChain, input.reviewState);
    const assistiveInference = assistiveInferenceForEvidence(indicators, evidenceChain, ruleFindings);
    const problemPatterns = buildExperienceProblemPatterns({
      skillName: segment.skillName,
      sessionId: segment.sessionId,
      timeline,
      reviewState: input.reviewState,
    });
    const hasGoalShift = userRefs.some((ref) => hasUserGoalShiftSignal(ref.snippet ?? ''));
    // 包含 sourceTrace 防止 main + subagent 因 segmentIndex 各自从 0 计数而撞 hash
    // （segmenter 给 segment.sessionId = sessionGroupId，main 和 subagent 共享）
    const goalSliceId = hashParts('goal', segment.sessionId, sourceTrace, segment.skillName, String(segment.segmentIndex));
    const invocationId = hashParts('invocation', segment.sessionId, sourceTrace, segment.skillName, String(segment.segmentIndex));

    goalSlices.push({
      id: goalSliceId,
      skillName: segment.skillName,
      sessionId: segment.sessionId,
      sourceTrace,
      cwd: segment.cwd,
      startTimestamp: segment.startTimestamp,
      endTimestamp: segment.endTimestamp,
      sliceReasonCode: hasGoalShift ? 'explicit_user_goal_shift' : 'skill_segment_boundary',
      sliceConfidence: hasGoalShift ? 'medium' : 'high',
      inferredUserGoal: inferUserGoal(userRefs),
      userMessageRefs: userRefs.slice(0, 8).map(evidenceRefFromTimeline),
    });

    invocations.push({
      id: invocationId,
      skillName: segment.skillName,
      sessionId: segment.sessionId,
      sourceTrace,
      sourceKind: segment.sourceKind ?? sourceKindForPath(sourceTrace),
      entrypoint: session ? session.entrypoint ?? inferEntrypointFromRecords(session) : undefined,
      sourceMetadata: session?.sourceMetadata,
      cwd: segment.cwd,
      segmentIndex: segment.segmentIndex,
      goalSliceId,
      startTimestamp: segment.startTimestamp,
      endTimestamp: segment.endTimestamp,
      attribution: {
        source: segment.attribution?.source ?? 'unknown',
        confidence: segment.attribution?.confidence ?? 0.3,
        rawSkillRef: segment.attribution?.rawSkillRef,
        pluginName: segment.attribution?.pluginName,
        commandName: segment.attribution?.commandName,
      },
      metrics: segment.metrics,
      toolCounts: countTools(segment),
      indicators,
      evidenceChain,
      ruleFindings,
      assistiveInference,
      problemPatterns,
      relatedObservationIds: relatedItems.map((item) => item.id),
      evidenceRefs: [
        ...observationRefs,
        ...userRefs.slice(0, 5).map(evidenceRefFromTimeline),
      ],
      timeline,
    });
  }

  const sessions = summarizeExperienceSessions(invocations, sessionGroupsById);
  const skills = summarizeExperienceSkills(sessions, invocations);

  return {
    kind: 'observe-experience',
    schemaVersion: 1,
    scope: 'evidence-only',
    generatedAt: input.generatedAt,
    meta: {
      sessionCount: sessions.length,
      skillCount: skills.length,
      invocationCount: invocations.length,
      goalSliceCount: goalSlices.length,
      noteCodes: ['no_llm_judge', 'no_auto_verdict', 'default_goal_slice_is_allowed', 'deterministic_assistive_inference'],
    },
    goalSlices,
    invocations,
    sessions,
    skills,
  };
}

function relatedObservationItems(segment: SkillSegment, items: ObservationInboxItem[]): ObservationInboxItem[] {
  return items.filter((item) =>
    item.skillName === segment.skillName
    && (item.sessionId === segment.sessionId || item.recentSessionIds.includes(segment.sessionId))
    && timestampsOverlap(item.firstSeen, item.lastSeen, segment.startTimestamp, segment.endTimestamp));
}

function logicalSessionId(session: CcSession): string {
  return session.sessionGroupId ?? session.sessionId;
}

function groupSessionsByLogicalId(sessions: CcSession[]): Map<string, CcSession[]> {
  const groups = new Map<string, CcSession[]>();
  for (const session of sessions) {
    const key = logicalSessionId(session);
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }
  for (const [key, group] of groups.entries()) {
    groups.set(key, group.sort(compareSessionsForTimeline));
  }
  return groups;
}

function compareSessionsForTimeline(a: CcSession, b: CcSession): number {
  const roleRank = (session: CcSession): number => session.traceRole === 'main' ? 0 : session.traceRole === 'standalone' ? 1 : 2;
  const rank = roleRank(a) - roleRank(b);
  if (rank !== 0) return rank;
  const time = (a.startTimestamp ?? '').localeCompare(b.startTimestamp ?? '');
  if (time !== 0) return time;
  return a.sourcePath.localeCompare(b.sourcePath);
}

function timestampsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return true;
  return aStart <= bEnd && bStart <= aEnd;
}

function segmentRecordBounds(session: CcSession, segment: SkillSegment): { start: number; end: number } {
  if (typeof segment.startRecordIndex === 'number' && typeof segment.endRecordIndex === 'number') {
    const rawStart = clampRecordIndex(session, segment.startRecordIndex);
    const rawEnd = clampRecordIndex(session, Math.max(segment.startRecordIndex, segment.endRecordIndex));
    const humanStart = Math.min(rawStart, previousHumanUserRecordIndex(session, rawStart) ?? rawStart);
    return {
      start: includeLeadingRuntimeContext(session, humanStart),
      end: includeTrailingDeliveryContext(session, Math.min(session.records.length, rawEnd + 1)),
    };
  }
  const indexes = segment.toolCalls
    .map((toolCall) => toolCall.messageIndex)
    .filter((index): index is number => typeof index === 'number' && index >= 0);
  if (indexes.length > 0) {
    const start = Math.max(0, Math.min(...indexes) - 3);
    return {
      start: Math.min(start, previousHumanUserRecordIndex(session, start) ?? start),
      end: includeTrailingDeliveryContext(session, Math.min(session.records.length, Math.max(...indexes) + 5)),
    };
  }
  const timestampIndexes: number[] = [];
  session.records.forEach((record, index) => {
    const ts = timestampOf(record);
    if (ts && ts >= segment.startTimestamp && ts <= segment.endTimestamp) timestampIndexes.push(index);
  });
  if (timestampIndexes.length === 0) return { start: 0, end: Math.min(session.records.length, 12) };
  const start = Math.max(0, Math.min(...timestampIndexes) - 2);
  return {
    start: Math.min(start, previousHumanUserRecordIndex(session, start) ?? start),
    end: includeTrailingDeliveryContext(session, Math.min(session.records.length, Math.max(...timestampIndexes) + 3)),
  };
}

function clampRecordIndex(session: CcSession, index: number): number {
  return Math.max(0, Math.min(session.records.length - 1, index));
}

function includeLeadingRuntimeContext(session: CcSession, start: number): number {
  let nextStart = start;
  for (let index = start - 1; index >= 0; index -= 1) {
    const events = timelineEventsFromRecord(session, session.records[index], index);
    if (events.length === 0) continue;
    if (events.some((event) => event.kind === 'runtime_context')) {
      nextStart = index;
      continue;
    }
    break;
  }
  return nextStart;
}

function includeTrailingDeliveryContext(session: CcSession, end: number): number {
  const safeEnd = Math.min(session.records.length, Math.max(0, end));
  const lookaheadEnd = Math.min(session.records.length, safeEnd + 8);
  for (let index = safeEnd; index < lookaheadEnd; index += 1) {
    const events = timelineEventsFromRecord(session, session.records[index], index);
    if (events.some((event) => event.kind === 'user_message')) break;
    if (events.some(isAssistantDeliveryEvent)) return index + 1;
  }
  return safeEnd;
}

function previousHumanUserRecordIndex(session: CcSession, start: number): number | undefined {
  for (let index = Math.min(start, session.records.length - 1); index >= 0; index -= 1) {
    const events = timelineEventsFromRecord(session, session.records[index], index);
    if (events.some((event) => event.kind === 'user_message')) return index;
  }
  return undefined;
}

function isAssistantDeliveryEvent(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'assistant_message') return false;
  const text = event.fullText ?? event.snippet ?? '';
  return hasAssistantDeliverySignalText(text);
}

function buildTimeline(session: CcSession, start: number, end: number): ExperienceTimelineEvent[] {
  return buildTimelineWindow(session, start, end).slice(0, TIMELINE_PREVIEW_EVENT_LIMIT);
}

function buildTimelineWindow(session: CcSession, start: number, end: number): ExperienceTimelineEvent[] {
  const events: ExperienceTimelineEvent[] = [];
  const safeEnd = Math.min(session.records.length, Math.max(start, end));
  for (let index = start; index < safeEnd; index += 1) {
    events.push(...timelineEventsFromRecord(session, session.records[index], index));
  }
  return events
    .sort((a, b) => a.order - b.order);
}

function timelineEventsFromRecord(session: CcSession, record: unknown, messageIndex: number): ExperienceTimelineEvent[] {
  if (!record || typeof record !== 'object') return [];
  const rec = record as CcRecord;
  const uuid = typeof (rec as { uuid?: unknown }).uuid === 'string' ? (rec as { uuid: string }).uuid : undefined;
  const timestamp = timestampOf(record);
  const base = {
    sourceTrace: session.sourcePath,
    sessionId: logicalSessionId(session),
    traceRole: session.traceRole,
    traceLabel: session.traceLabel,
    messageIndex,
    messageUuid: uuid,
    timestamp,
  };
  if (rec.type === 'user') {
    const user = rec as CcUserRecord;
    return userEvents(user, base, messageIndex);
  }
  if (rec.type === 'assistant') {
    const assistant = rec as CcAssistantRecord;
    return assistantEvents(assistant, base, messageIndex);
  }
  return [];
}

function userEvents(
  record: CcUserRecord,
  base: Omit<ExperienceTimelineEvent, 'id' | 'kind' | 'order'>,
  messageIndex: number,
): ExperienceTimelineEvent[] {
  const content = record.message.content;
  const events: ExperienceTimelineEvent[] = [];
  if (typeof content === 'string') {
    events.push(...userTextEventsFromText(record, content, base, messageIndex, 0));
    return events;
  }
  let textIndex = 0;
  let resultIndex = 0;
  for (const part of content) {
    if (part.type === 'text') {
      const nextEvents = userTextEventsFromText(record, part.text, base, messageIndex, textIndex);
      events.push(...nextEvents);
      if (nextEvents.length > 0) textIndex += nextEvents.length;
    } else if (part.type === 'tool_result') {
      const full = fullText(part.content);
      const text = snippet(part.content, 900);
      events.push(timelineEvent({
        ...base,
        kind: 'tool_result',
        role: 'tool',
        order: messageIndex * 10 + 5 + resultIndex,
        toolUseId: part.tool_use_id,
        isError: part.is_error === true,
        snippet: text,
        fullText: full,
        label: part.is_error === true ? 'tool result error' : 'tool result',
      }));
      resultIndex += 1;
    }
  }
  return events;
}

function userTextEventsFromText(
  record: CcUserRecord,
  rawText: string,
  base: Omit<ExperienceTimelineEvent, 'id' | 'kind' | 'order'>,
  messageIndex: number,
  offset: number,
): ExperienceTimelineEvent[] {
  const events: ExperienceTimelineEvent[] = [];
  const commandEnvelope = extractCommandEnvelopeText(rawText);
  if (commandEnvelope) {
    events.push(timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'tool',
      order: messageIndex * 10 + offset,
      snippet: snippet(commandEnvelope, 700),
      fullText: fullText(commandEnvelope),
      label: 'command envelope',
    }));
  }
  const humanText = commandEnvelope ? stripCommandEnvelopeText(rawText) : rawText;
  const full = fullText(humanText);
  const text = snippet(humanText, 700);
  if (text) {
    const kind = userTextEventKind(record, text);
    events.push(timelineEvent({
      ...base,
      kind,
      role: kind === 'user_message' ? 'user' : 'tool',
      order: messageIndex * 10 + offset + (commandEnvelope ? 1 : 0),
      snippet: text,
      fullText: full,
      label: userTextEventLabel(kind),
    }));
  }
  return events;
}

function assistantEvents(
  record: CcAssistantRecord,
  base: Omit<ExperienceTimelineEvent, 'id' | 'kind' | 'order'>,
  messageIndex: number,
): ExperienceTimelineEvent[] {
  const events: ExperienceTimelineEvent[] = [];
  const textParts: string[] = [];
  let index = 0;
  for (const part of record.message.content) {
    if (part.type === 'text' && part.text) textParts.push(part.text);
    if (part.type === 'tool_use' && part.id && part.name) {
      const inputText = JSON.stringify(part.input ?? {});
      events.push(timelineEvent({
        ...base,
        kind: 'tool_use',
        role: 'assistant',
        order: messageIndex * 10 + 5 + index,
        toolUseId: part.id,
        toolName: part.name,
        snippet: snippet(inputText, 900),
        fullText: fullText(inputText),
        label: `tool_use ${part.name}`,
      }));
      index += 1;
    }
  }
  const rawText = textParts.join('\n');
  const text = snippet(rawText, 700);
  if (text) {
    events.unshift(timelineEvent({
      ...base,
      kind: 'assistant_message',
      role: 'assistant',
      order: messageIndex * 10,
      snippet: text,
      fullText: fullText(rawText),
      label: 'assistant message',
    }));
  }
  return events;
}

function timelineEvent(input: Omit<ExperienceTimelineEvent, 'id'>): ExperienceTimelineEvent {
  return {
    ...input,
    id: hashParts(input.sourceTrace, input.sessionId, String(input.messageIndex ?? ''), input.kind, input.toolUseId ?? '', input.snippet ?? ''),
  };
}

function userTextEventKind(record: CcUserRecord, text: string): 'user_message' | 'skill_context' | 'runtime_context' {
  if (isSkillContextRecord(record, text)) return 'skill_context';
  if (isRuntimeContextRecord(record, text)) return 'runtime_context';
  return 'user_message';
}

function userTextEventLabel(kind: 'user_message' | 'skill_context' | 'runtime_context'): string {
  if (kind === 'skill_context') return 'skill context';
  if (kind === 'runtime_context') return 'runtime context';
  return 'user message';
}

function observationEvidenceRef(item: ObservationInboxItem): ExperienceEvidenceRef {
  return {
    id: hashParts('observation', item.id),
    kind: 'observation',
    sourceTrace: item.sourceTrace,
    sessionId: item.sessionId,
    messageIndex: item.evidence.messageIndex,
    messageUuid: item.evidence.messageUuid,
    toolUseId: item.evidence.toolUseId,
    timestamp: item.evidence.segmentTimestamp,
    role: 'other',
    label: `${item.signalType}/${item.signalSubtype}`,
    snippet: snippet(item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || item.evidence.outputSnippet || item.evidence.markerToken, 700),
  };
}

function evidenceRefFromTimeline(event: ExperienceTimelineEvent): ExperienceEvidenceRef {
  return {
    id: event.id,
    kind: event.kind,
    sourceTrace: event.sourceTrace,
    sessionId: event.sessionId,
    traceRole: event.traceRole,
    traceLabel: event.traceLabel,
    messageIndex: event.messageIndex,
    messageUuid: event.messageUuid,
    toolUseId: event.toolUseId,
    timestamp: event.timestamp,
    role: event.role,
    label: event.label,
    snippet: event.snippet,
  };
}

function evidenceChainForTimeline(
  timeline: ExperienceTimelineEvent[],
  observationRefs: ExperienceEvidenceRef[],
): ExperienceEvidenceChain {
  const events = uniqueTimelineEvents(timeline).sort(compareTimelineEvents);
  const userEvents = events.filter((event) => event.kind === 'user_message');
  const runtimeEvents = events.filter((event) => event.kind === 'runtime_context');
  const skillEvents = events.filter((event) => event.kind === 'skill_context');
  const assistantEvents = events.filter((event) => event.kind === 'assistant_message');
  const toolUseEvents = events.filter((event) => event.kind === 'tool_use');
  const toolResultEvents = events.filter((event) => event.kind === 'tool_result');
  const toolFailureEvents = toolResultEvents.filter((event) => event.isError === true);
  return {
    userMessageCount: userEvents.length,
    runtimeContextCount: runtimeEvents.length,
    skillContextCount: skillEvents.length,
    assistantMessageCount: assistantEvents.length,
    toolUseCount: toolUseEvents.length,
    toolResultCount: toolResultEvents.length,
    toolFailureResultCount: toolFailureEvents.length,
    observationCount: observationRefs.length,
    firstUserMessage: userEvents[0] ? evidenceRefFromTimeline(userEvents[0]) : undefined,
    firstRuntimeContext: runtimeEvents[0] ? evidenceRefFromTimeline(runtimeEvents[0]) : undefined,
    firstSkillContext: skillEvents[0] ? evidenceRefFromTimeline(skillEvents[0]) : undefined,
    firstToolUse: toolUseEvents[0] ? evidenceRefFromTimeline(toolUseEvents[0]) : undefined,
    firstToolFailure: toolFailureEvents[0] ? evidenceRefFromTimeline(toolFailureEvents[0]) : undefined,
    lastAssistantMessage: assistantEvents.at(-1) ? evidenceRefFromTimeline(assistantEvents.at(-1) as ExperienceTimelineEvent) : undefined,
  };
}

function ruleFindingsForEvidence(
  indicators: ExperienceReviewIndicators,
  timeline: ExperienceTimelineEvent[],
  observationRefs: ExperienceEvidenceRef[],
  evidenceChain: ExperienceEvidenceChain,
  reviewState?: ObservationReviewState,
): ExperienceRuleFinding[] {
  const events = uniqueTimelineEvents(timeline);
  const userEvents = events.filter((event) => event.kind === 'user_message');
  const metricUserEvents = userEvents.filter((event) => !isScheduledTaskPromptText(event.snippet ?? ''));
  const refs = (matches: ExperienceTimelineEvent[]): ExperienceEvidenceRef[] =>
    matches.slice(0, 5).map(evidenceRefFromTimeline);
  const findings: ExperienceRuleFinding[] = [];
  const push = (
    code: ExperienceRuleFindingCode,
    level: ExperienceRuleFindingLevel,
    count: number,
    evidenceRefs: ExperienceEvidenceRef[] = [],
  ): void => {
    if (count <= 0) return;
    findings.push({ code, level, count, evidenceRefs: uniqueEvidenceRefs(evidenceRefs).slice(0, 5) });
  };

  push('high_observation_seen', 'attention', indicators.highObservationCount, observationRefs);
  push('user_correction_seen', 'attention', indicators.userCorrectionCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'user_correction', hasUserCorrectionSignal(event.snippet ?? ''), reviewState))));
  push('user_interruption_seen', 'attention', indicators.userInterruptionCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'user_interruption', USER_INTERRUPTION_RE.test(event.snippet ?? ''), reviewState))));
  push('negative_feedback_seen', 'attention', indicators.negativeFeedbackCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'negative_feedback', hasNegativeFeedbackSignal(event.snippet ?? ''), reviewState))));
  push('tool_failure_seen', 'sample', indicators.toolFailureCount, refs(events.filter((event) => event.kind === 'tool_result' && event.isError === true)));
  push('medium_observation_seen', 'sample', indicators.mediumObservationCount, observationRefs);
  push('hedging_seen', 'sample', indicators.hedgingCount, observationRefs);
  push('explicit_marker_seen', 'sample', indicators.explicitMarkerCount, observationRefs);
  push('hard_rule_seen', 'sample', indicators.hardRuleTextHitCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'hard_rule', hasUserHardRuleText(event.snippet ?? ''), reviewState))));
  push('positive_feedback_seen', 'normal', indicators.positiveFeedbackCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'positive_feedback', hasPositiveFeedbackSignal(event.snippet ?? ''), reviewState))));
  push('user_goal_shift_seen', 'normal', indicators.userGoalShiftCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'user_goal_shift', hasUserGoalShiftSignal(event.snippet ?? ''), reviewState))));
  push('runtime_context_excluded', 'normal', evidenceChain.runtimeContextCount, evidenceChain.firstRuntimeContext ? [evidenceChain.firstRuntimeContext] : []);
  push('skill_context_excluded', 'normal', evidenceChain.skillContextCount, evidenceChain.firstSkillContext ? [evidenceChain.firstSkillContext] : []);

  if (findings.filter((finding) => finding.level !== 'normal').length === 0) {
    findings.push({ code: 'no_priority_signal', level: 'normal', count: 1, evidenceRefs: [] });
  }
  return findings;
}

function assistiveInferenceForEvidence(
  indicators: ExperienceReviewIndicators,
  evidenceChain: ExperienceEvidenceChain,
  ruleFindings: ExperienceRuleFinding[],
): ExperienceAssistiveInference {
  const attentionFindings = ruleFindings.filter((finding) => finding.level === 'attention');
  const sampleFindings = ruleFindings.filter((finding) => finding.level === 'sample');
  const normalFindings = ruleFindings.filter((finding) => finding.level === 'normal');
  const basisRuleCodes = unique([
    ...attentionFindings.map((finding) => finding.code),
    ...sampleFindings.map((finding) => finding.code),
    ...normalFindings
      .filter((finding) => finding.code === 'positive_feedback_seen' || finding.code === 'hard_rule_seen' || finding.code === 'user_goal_shift_seen' || finding.code === 'no_priority_signal')
      .map((finding) => finding.code),
  ]);
  const cautionCodes: ExperienceAssistiveInferenceCautionCode[] = ['no_llm_judge', 'rule_only'];
  if (evidenceChain.runtimeContextCount > 0) cautionCodes.push('runtime_context_excluded');
  if (evidenceChain.skillContextCount > 0) cautionCodes.push('skill_context_excluded');
  if (evidenceChain.userMessageCount === 0) cautionCodes.push('no_human_user_message');
  if (evidenceChain.toolUseCount + evidenceChain.toolResultCount + evidenceChain.assistantMessageCount > 24) cautionCodes.push('limited_timeline_window');

  let code: ExperienceAssistiveInferenceCode;
  if (attentionFindings.length > 0) {
    code = 'review_recommended';
  } else if (sampleFindings.length > 0) {
    code = 'sample_recommended';
  } else if (indicators.positiveFeedbackCount > 0) {
    code = 'positive_signal_observed';
  } else if (indicators.userGoalShiftCount > 0) {
    code = 'user_switched_topic_neutral';
  } else if (evidenceChain.userMessageCount === 0 && evidenceChain.toolUseCount === 0 && evidenceChain.observationCount === 0) {
    code = 'insufficient_human_context';
  } else if (evidenceChain.userMessageCount === 0 && indicators.hardRuleTextHitCount === 0) {
    code = 'insufficient_human_context';
  } else {
    code = 'no_obvious_issue_from_rules';
  }

  const confidence: ExperienceAssistiveInferenceConfidence =
    attentionFindings.length > 0 || indicators.positiveFeedbackCount > 0
      ? 'high'
      : sampleFindings.length > 0 || indicators.userGoalShiftCount > 0 || evidenceChain.userMessageCount > 0 || evidenceChain.toolUseCount > 0
        ? 'medium'
        : 'low';
  const evidenceRefs = uniqueEvidenceRefs([
    ...attentionFindings.flatMap((finding) => finding.evidenceRefs),
    ...sampleFindings.flatMap((finding) => finding.evidenceRefs),
    ...(evidenceChain.firstUserMessage ? [evidenceChain.firstUserMessage] : []),
    ...(evidenceChain.firstToolUse ? [evidenceChain.firstToolUse] : []),
    ...(evidenceChain.firstToolFailure ? [evidenceChain.firstToolFailure] : []),
  ]).slice(0, 8);

  return {
    mode: 'deterministic_rules_only',
    code,
    confidence,
    basisRuleCodes,
    cautionCodes: unique(cautionCodes),
    evidenceRefs,
  };
}

function indicatorsForSegment(
  segment: SkillSegment,
  relatedItems: ObservationInboxItem[],
  timeline: ExperienceTimelineEvent[],
  reviewState?: ObservationReviewState,
): ExperienceReviewIndicators {
  const userRefs = timeline.filter((event) => event.kind === 'user_message');
  const humanUserRefs = userRefs.filter((ref) => Boolean(ref.snippet));
  const interactionUserRefs = humanUserRefs.filter((ref) => !isScheduledTaskPromptText(ref.snippet ?? ''));
  return {
    userMessageCount: humanUserRefs.length,
    userFollowUpCount: interactionUserRefs.reduce((sum, ref, index) => sum + (metricIsActive(ref, 'user_follow_up', index > 0, reviewState) ? 1 : 0), 0),
    userCorrectionCount: interactionUserRefs.reduce((sum, ref) => sum + metricCount(ref, 'user_correction', findUserCorrectionMatches(ref.snippet ?? '').length, reviewState), 0),
    userInterruptionCount: interactionUserRefs.reduce((sum, ref) => sum + (metricIsActive(ref, 'user_interruption', USER_INTERRUPTION_RE.test(ref.snippet ?? ''), reviewState) ? 1 : 0), 0),
    negativeFeedbackCount: interactionUserRefs.reduce((sum, ref) => sum + metricCount(ref, 'negative_feedback', findNegativeFeedbackMatches(ref.snippet ?? '').length, reviewState), 0),
    positiveFeedbackCount: interactionUserRefs.reduce((sum, ref) => sum + metricCount(ref, 'positive_feedback', findPositiveFeedbackMatches(ref.snippet ?? '').length, reviewState), 0),
    userGoalShiftCount: interactionUserRefs.reduce((sum, ref) => sum + metricCount(ref, 'user_goal_shift', findUserGoalShiftMatches(ref.snippet ?? '').length, reviewState), 0),
    hardRuleTextHitCount: interactionUserRefs.reduce((sum, ref) => sum + (metricIsActive(ref, 'hard_rule', hasUserHardRuleText(ref.snippet ?? ''), reviewState) ? 1 : 0), 0),
    assistantDeliverySignalCount: timeline.filter(isAssistantDeliveryEvent).length,
    toolCallCount: segment.metrics.numToolCalls,
    toolFailureCount: segment.metrics.numToolFailures,
    highObservationCount: relatedItems.filter((item) => item.severity === 'high').length,
    mediumObservationCount: relatedItems.filter((item) => item.severity === 'medium').length,
    hedgingCount: relatedItems.filter((item) => item.signalType === 'hedging').reduce((sum, item) => sum + item.occurrences, 0),
    explicitMarkerCount: relatedItems.filter((item) => item.signalType === 'explicit_marker').reduce((sum, item) => sum + item.occurrences, 0),
  };
}

function metricIsActive(
  ref: ExperienceTimelineEvent,
  metricKey: ObservationMetricKey,
  ruleDetected: boolean,
  reviewState?: ObservationReviewState,
): boolean {
  const verdict = observationMetricAnnotationVerdict(reviewState, ref, metricKey);
  if (verdict === 'confirmed') return true;
  if (verdict === 'rejected') return false;
  return ruleDetected;
}

function metricCount(
  ref: ExperienceTimelineEvent,
  metricKey: ObservationMetricKey,
  ruleCount: number,
  reviewState?: ObservationReviewState,
): number {
  const verdict = observationMetricAnnotationVerdict(reviewState, ref, metricKey);
  if (verdict === 'confirmed') return Math.max(1, ruleCount);
  if (verdict === 'rejected') return 0;
  return ruleCount;
}

function summarizeExperienceSessions(invocations: ExperienceInvocation[], sessionGroupsById: Map<string, CcSession[]>): ExperienceSessionSummary[] {
  const byKey = new Map<string, ExperienceInvocation[]>();
  for (const invocation of invocations) {
    const key = `${invocation.skillName}\u0000${invocation.sessionId}`;
    const group = byKey.get(key) ?? [];
    group.push(invocation);
    byKey.set(key, group);
  }

  return Array.from(byKey.values()).map((group): ExperienceSessionSummary => {
    const first = group[0];
    const indicators = sumIndicators(group.map((invocation) => invocation.indicators));
    const relatedObservationIds = unique(group.flatMap((invocation) => invocation.relatedObservationIds));
    const reviewBasisCodes = basisCodesForIndicators(indicators);
    const reviewPriorityScore = scoreForIndicators(indicators);
    const timeline = uniqueTimelineEvents(group.flatMap((invocation) => invocation.timeline)).sort(compareTimelineEvents);
    const sessionGroup = sessionGroupsById.get(first.sessionId) ?? [];
    const sourceSessionStartTimestamp = minString(sessionGroup.map((session) => session.startTimestamp));
    const sourceSessionEndTimestamp = maxString(sessionGroup.map((session) => session.endTimestamp));
    const timelineTree = sessionGroup.length > 0 ? buildSessionTimelineTree(first.sessionId, sessionGroup) : undefined;
    const fullSessionTimeline = timelineTree
      ? uniqueTimelineEvents([
        ...timelineTree.main,
        ...timelineTree.branches.flatMap((branch) => branch.events),
      ]).sort(compareTimelineEvents)
      : timeline;
    const fullSessionEventCount = fullSessionTimeline.length;
    const previewEvents = timeline.slice(0, TIMELINE_PREVIEW_EVENT_LIMIT);
    const previewIndexes = previewEvents
      .map((event) => event.messageIndex)
      .filter((index): index is number => typeof index === 'number');
    const groupStartRecordIndex = minDefined(group.map((invocation) => minDefined(invocation.timeline.map((event) => event.messageIndex))));
    const groupEndRecordIndex = maxDefined(group.map((invocation) => maxDefined(invocation.timeline.map((event) => event.messageIndex))));
    const previewStartRecordIndex = minDefined(previewIndexes);
    const previewEndRecordIndex = maxDefined(previewIndexes);
    const fullSessionIndexes = fullSessionTimeline
      .map((event) => event.messageIndex)
      .filter((index): index is number => typeof index === 'number');
    const sessionStartRecordIndex = minDefined(fullSessionIndexes) ?? 0;
    const sessionEndRecordIndex = maxDefined(fullSessionIndexes) ?? Math.max(0, (sessionGroup[0]?.records.length ?? 1) - 1);
    const omittedBeforeCount = previewStartRecordIndex === undefined
      ? 0
      : fullSessionTimeline.filter((event) => typeof event.messageIndex === 'number' && event.messageIndex < previewStartRecordIndex).length;
    const omittedAfterCount = previewEndRecordIndex === undefined
      ? 0
      : fullSessionTimeline.filter((event) => typeof event.messageIndex === 'number' && event.messageIndex > previewEndRecordIndex).length;
    const observationRefs = uniqueEvidenceRefs(group.flatMap((invocation) => invocation.evidenceRefs.filter((ref) => ref.kind === 'observation')));
    const evidenceChain = evidenceChainForTimeline(timeline, observationRefs);
    const ruleFindings = ruleFindingsForEvidence(indicators, timeline, observationRefs, evidenceChain);
    const assistiveInference = assistiveInferenceForEvidence(indicators, evidenceChain, ruleFindings);
    const problemPatterns = mergeExperienceProblemPatterns(group.flatMap((invocation) => invocation.problemPatterns));
    return {
      id: hashParts('session', first.skillName, first.sessionId),
      skillName: first.skillName,
      sessionId: first.sessionId,
      sourceTrace: first.sourceTrace,
      sourceKind: first.sourceKind,
      entrypoint: first.entrypoint,
      sourceMetadata: mergeSourceMetadata(group.map((invocation) => invocation.sourceMetadata)),
      cwd: first.cwd,
      sourceSessionStartTimestamp,
      sourceSessionEndTimestamp,
      sourceSessionDurationMs: durationMsBetween(sourceSessionStartTimestamp, sourceSessionEndTimestamp),
      startTimestamp: group.reduce((min, invocation) => invocation.startTimestamp < min ? invocation.startTimestamp : min, first.startTimestamp),
      endTimestamp: group.reduce((max, invocation) => invocation.endTimestamp > max ? invocation.endTimestamp : max, first.endTimestamp),
      invocationIds: group.map((invocation) => invocation.id),
      goalSliceIds: unique(group.map((invocation) => invocation.goalSliceId)),
      reviewPriority: priorityForScore(reviewPriorityScore),
      reviewPriorityScore,
      reviewBasisCodes,
      indicators,
      evidenceChain,
      ruleFindings,
      assistiveInference,
      problemPatterns,
      relatedObservationIds,
      timelinePreview: previewEvents,
      fullSessionTimeline,
      timelineTree,
      timelineScope: {
        mode: 'skill_segment_window',
        segmentStartRecordIndex: groupStartRecordIndex,
        segmentEndRecordIndex: groupEndRecordIndex,
        previewStartRecordIndex,
        previewEndRecordIndex,
        sessionStartRecordIndex,
        sessionEndRecordIndex,
        previewEventCount: previewEvents.length,
        fullSessionEventCount,
        truncated: timeline.length > previewEvents.length || omittedBeforeCount > 0 || omittedAfterCount > 0,
        omittedBeforeCount,
        omittedAfterCount,
      },
      attributionSources: unique(group.map((invocation) => invocation.attribution.source).filter(Boolean)).sort(),
      pluginNames: unique(group.map((invocation) => invocation.attribution.pluginName).filter((value): value is string => Boolean(value))).sort(),
      rawSkillRefs: unique(group.map((invocation) => invocation.attribution.rawSkillRef).filter((value): value is string => Boolean(value))).sort(),
      commandNames: unique(group.map((invocation) => invocation.attribution.commandName).filter((value): value is string => Boolean(value))).sort(),
    };
  }).sort((a, b) => {
    if (b.reviewPriorityScore !== a.reviewPriorityScore) return b.reviewPriorityScore - a.reviewPriorityScore;
    return b.endTimestamp.localeCompare(a.endTimestamp);
  });
}

function summarizeExperienceSkills(
  sessions: ExperienceSessionSummary[],
  invocations: ExperienceInvocation[],
): ExperienceSkillSummary[] {
  const bySkill = new Map<string, ExperienceSessionSummary[]>();
  for (const session of sessions) {
    const group = bySkill.get(session.skillName) ?? [];
    group.push(session);
    bySkill.set(session.skillName, group);
  }
  const invocationCountBySkill = invocations.reduce((acc, invocation) => {
    acc[invocation.skillName] = (acc[invocation.skillName] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const invocationGroupBySkill = invocations.reduce((acc, invocation) => {
    const group = acc.get(invocation.skillName) ?? [];
    group.push(invocation);
    acc.set(invocation.skillName, group);
    return acc;
  }, new Map<string, ExperienceInvocation[]>());

  return Array.from(bySkill.entries()).map(([skillName, group]): ExperienceSkillSummary => {
    const first = group[0];
    const skillInvocations = invocationGroupBySkill.get(skillName) ?? [];
    const indicators = sumIndicators(group.map((session) => session.indicators));
    const evidenceChain = sumEvidenceChains(group.map((session) => session.evidenceChain));
    const ruleFindings = mergeRuleFindings(group.flatMap((session) => session.ruleFindings));
    const problemPatterns = mergeExperienceProblemPatterns(group.flatMap((session) => session.problemPatterns));
    return {
      skillName,
      invocationCount: invocationCountBySkill[skillName] ?? 0,
      sessionCount: group.length,
      sourceKinds: unique(group.map((session) => session.sourceKind)).sort(),
      entrypoints: unique(group.map((session) => session.entrypoint).filter((value): value is string => Boolean(value))).sort(),
      entrypointCounts: countBy(skillInvocations.map((invocation) => invocation.entrypoint ?? invocation.sourceKind ?? 'unknown')),
      sourceMetadataCounts: summarizeSourceMetadataCounts(skillInvocations.map((invocation) => invocation.sourceMetadata)),
      attributionCounts: countBy(skillInvocations.map((invocation) => invocation.attribution.source || 'unknown')),
      pluginNames: unique(skillInvocations.map((invocation) => invocation.attribution.pluginName).filter((value): value is string => Boolean(value))).sort(),
      rawSkillRefs: unique(skillInvocations.map((invocation) => invocation.attribution.rawSkillRef).filter((value): value is string => Boolean(value))).sort(),
      commandNames: unique(skillInvocations.map((invocation) => invocation.attribution.commandName).filter((value): value is string => Boolean(value))).sort(),
      toolCounts: sumRecordCounts(skillInvocations.map((invocation) => invocation.toolCounts)),
      firstSeen: group.reduce((min, session) => session.startTimestamp < min ? session.startTimestamp : min, first.startTimestamp),
      lastSeen: group.reduce((max, session) => session.endTimestamp > max ? session.endTimestamp : max, first.endTimestamp),
      reviewFirstSessionCount: group.filter((session) => session.reviewPriority === 'review_first').length,
      sampleReviewSessionCount: group.filter((session) => session.reviewPriority === 'sample_review').length,
      indicators,
      evidenceChain,
      ruleFindings,
      assistiveInference: assistiveInferenceForEvidence(indicators, evidenceChain, ruleFindings),
      problemPatterns,
      relatedObservationIds: unique(group.flatMap((session) => session.relatedObservationIds)),
    };
  }).sort((a, b) => {
    const aScore = a.reviewFirstSessionCount * 100 + a.sampleReviewSessionCount * 10 + a.indicators.highObservationCount;
    const bScore = b.reviewFirstSessionCount * 100 + b.sampleReviewSessionCount * 10 + b.indicators.highObservationCount;
    if (bScore !== aScore) return bScore - aScore;
    return b.invocationCount - a.invocationCount;
  });
}

function mergeSourceMetadata(values: Array<TraceSourceMetadata | undefined>): TraceSourceMetadata | undefined {
  const channels = unique(values.map((value) => value?.channel).filter((value): value is string => Boolean(value)));
  const senders = unique(values.map((value) => value?.sender).filter((value): value is string => Boolean(value)));
  const senderIds = unique(values.map((value) => value?.senderId).filter((value): value is string => Boolean(value)));
  const providers = unique(values.map((value) => value?.provider).filter((value): value is string => Boolean(value)));
  const models = unique(values.map((value) => value?.model).filter((value): value is string => Boolean(value)));
  const modelApis = unique(values.map((value) => value?.modelApi).filter((value): value is string => Boolean(value)));
  const aimaCommands = unique(values.flatMap((value) => value?.aimaCommands ?? []));
  const merged: TraceSourceMetadata = {};
  if (channels.length > 0) merged.channel = channels.join(', ');
  if (senders.length > 0) merged.sender = senders.join(', ');
  if (senderIds.length > 0) merged.senderId = senderIds.join(', ');
  if (providers.length > 0) merged.provider = providers.join(', ');
  if (models.length > 0) merged.model = models.join(', ');
  if (modelApis.length > 0) merged.modelApi = modelApis.join(', ');
  if (aimaCommands.length > 0) merged.aimaCommands = aimaCommands.sort();
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function summarizeSourceMetadataCounts(values: Array<TraceSourceMetadata | undefined>): ExperienceSkillSummary['sourceMetadataCounts'] {
  return {
    channels: countBy(values.map((value) => value?.channel).filter((value): value is string => Boolean(value))),
    senders: countBy(values.map((value) => sourceSenderLabel(value)).filter((value): value is string => Boolean(value))),
    aimaCommands: countBy(values.flatMap((value) => value?.aimaCommands ?? [])),
    providers: countBy(values.map((value) => value?.provider).filter((value): value is string => Boolean(value))),
    models: countBy(values.map((value) => value?.model).filter((value): value is string => Boolean(value))),
  };
}

function sourceSenderLabel(value?: TraceSourceMetadata): string | undefined {
  if (!value?.sender && !value?.senderId) return undefined;
  if (value.sender && value.senderId) return `${value.sender}(${value.senderId})`;
  return value.sender ?? value.senderId;
}

function scoreForIndicators(indicators: ExperienceReviewIndicators): number {
  return indicators.highObservationCount * 3
    + indicators.mediumObservationCount
    + indicators.userCorrectionCount * 2
    + indicators.userInterruptionCount * 2
    + indicators.negativeFeedbackCount * 2
    + indicators.hardRuleTextHitCount
    + indicators.toolFailureCount
    + indicators.hedgingCount
    + indicators.explicitMarkerCount * 2;
}

function priorityForScore(score: number): ExperienceReviewPriority {
  if (score >= 3) return 'review_first';
  if (score > 0) return 'sample_review';
  return 'routine_sample';
}

function basisCodesForIndicators(indicators: ExperienceReviewIndicators): ExperienceReviewBasisCode[] {
  const codes: ExperienceReviewBasisCode[] = [];
  if (indicators.highObservationCount > 0) codes.push('has_high_observation');
  if (indicators.mediumObservationCount > 0) codes.push('has_medium_observation');
  if (indicators.userCorrectionCount > 0) codes.push('user_correction');
  if (indicators.userInterruptionCount > 0) codes.push('user_interruption');
  if (indicators.negativeFeedbackCount > 0) codes.push('negative_feedback');
  if (indicators.hardRuleTextHitCount > 0) codes.push('hard_rule_text_hit');
  if (indicators.toolFailureCount > 0) codes.push('tool_failure');
  if (indicators.hedgingCount > 0) codes.push('hedging_signal');
  if (indicators.explicitMarkerCount > 0) codes.push('explicit_marker');
  return codes;
}

function countTools(segment: SkillSegment): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const toolCall of segment.toolCalls) {
    counts[toolCall.tool] = (counts[toolCall.tool] ?? 0) + 1;
  }
  return counts;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function sumRecordCounts(values: Array<Record<string, number>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    for (const [key, count] of Object.entries(value)) {
      counts[key] = (counts[key] ?? 0) + count;
    }
  }
  return counts;
}

function sumIndicators(values: ExperienceReviewIndicators[]): ExperienceReviewIndicators {
  return values.reduce((acc, value) => ({
    userMessageCount: acc.userMessageCount + value.userMessageCount,
    userFollowUpCount: acc.userFollowUpCount + value.userFollowUpCount,
    userCorrectionCount: acc.userCorrectionCount + value.userCorrectionCount,
    userInterruptionCount: acc.userInterruptionCount + value.userInterruptionCount,
    negativeFeedbackCount: acc.negativeFeedbackCount + (value.negativeFeedbackCount ?? 0),
    positiveFeedbackCount: acc.positiveFeedbackCount + (value.positiveFeedbackCount ?? 0),
    userGoalShiftCount: acc.userGoalShiftCount + (value.userGoalShiftCount ?? 0),
    hardRuleTextHitCount: acc.hardRuleTextHitCount + value.hardRuleTextHitCount,
    assistantDeliverySignalCount: acc.assistantDeliverySignalCount + (value.assistantDeliverySignalCount ?? 0),
    toolCallCount: acc.toolCallCount + value.toolCallCount,
    toolFailureCount: acc.toolFailureCount + value.toolFailureCount,
    highObservationCount: acc.highObservationCount + value.highObservationCount,
    mediumObservationCount: acc.mediumObservationCount + value.mediumObservationCount,
    hedgingCount: acc.hedgingCount + value.hedgingCount,
    explicitMarkerCount: acc.explicitMarkerCount + value.explicitMarkerCount,
  }), { ...ZERO_INDICATORS });
}

function sumEvidenceChains(values: ExperienceEvidenceChain[]): ExperienceEvidenceChain {
  return values.reduce((acc, value) => ({
    userMessageCount: acc.userMessageCount + (value?.userMessageCount ?? 0),
    runtimeContextCount: acc.runtimeContextCount + (value?.runtimeContextCount ?? 0),
    skillContextCount: acc.skillContextCount + (value?.skillContextCount ?? 0),
    assistantMessageCount: acc.assistantMessageCount + (value?.assistantMessageCount ?? 0),
    toolUseCount: acc.toolUseCount + (value?.toolUseCount ?? 0),
    toolResultCount: acc.toolResultCount + (value?.toolResultCount ?? 0),
    toolFailureResultCount: acc.toolFailureResultCount + (value?.toolFailureResultCount ?? 0),
    observationCount: acc.observationCount + (value?.observationCount ?? 0),
    firstUserMessage: acc.firstUserMessage ?? value?.firstUserMessage,
    firstRuntimeContext: acc.firstRuntimeContext ?? value?.firstRuntimeContext,
    firstSkillContext: acc.firstSkillContext ?? value?.firstSkillContext,
    firstToolUse: acc.firstToolUse ?? value?.firstToolUse,
    firstToolFailure: acc.firstToolFailure ?? value?.firstToolFailure,
    lastAssistantMessage: value?.lastAssistantMessage ?? acc.lastAssistantMessage,
  }), {
    userMessageCount: 0,
    runtimeContextCount: 0,
    skillContextCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    toolFailureResultCount: 0,
    observationCount: 0,
  });
}

function mergeRuleFindings(values: ExperienceRuleFinding[]): ExperienceRuleFinding[] {
  const byCode = new Map<ExperienceRuleFindingCode, ExperienceRuleFinding>();
  for (const value of values) {
    const existing = byCode.get(value.code);
    if (existing) {
      existing.count += value.count;
      existing.evidenceRefs = uniqueEvidenceRefs([...existing.evidenceRefs, ...value.evidenceRefs]).slice(0, 5);
    } else {
      byCode.set(value.code, { ...value, evidenceRefs: uniqueEvidenceRefs(value.evidenceRefs).slice(0, 5) });
    }
  }
  return Array.from(byCode.values()).sort((a, b) => {
    const rank: Record<ExperienceRuleFindingLevel, number> = { attention: 0, sample: 1, normal: 2 };
    if (rank[a.level] !== rank[b.level]) return rank[a.level] - rank[b.level];
    return b.count - a.count;
  });
}

function uniqueTimelineEvents(events: ExperienceTimelineEvent[]): ExperienceTimelineEvent[] {
  const byId = new Map<string, ExperienceTimelineEvent>();
  for (const event of events) {
    byId.set(event.id, event);
  }
  return Array.from(byId.values());
}

function compareTimelineEvents(a: ExperienceTimelineEvent, b: ExperienceTimelineEvent): number {
  const ta = a.timestamp;
  const tb = b.timestamp;
  // 双方都有非空 timestamp 且不同 → 按时间穿插（主线 + subagent 真实交互序）
  if (ta && tb && ta !== tb) {
    return ta.localeCompare(tb);
  }
  // 同一条 trace 内 → 按 messageIndex 派生的 order（跨 trace 比 order 没意义）
  if (a.sourceTrace === b.sourceTrace) {
    return a.order - b.order;
  }
  // 跨 trace 且 timestamp 不可比 → 主线优先（避免缺 timestamp 时 subagent 顶到最前）
  const roleRank = (event: ExperienceTimelineEvent): number =>
    event.traceRole === 'main' || event.traceRole === 'standalone' ? 0 : 1;
  const rankDiff = roleRank(a) - roleRank(b);
  if (rankDiff !== 0) return rankDiff;
  // 同 traceRole 跨文件兜底：sourceTrace 字典序保证稳定
  return a.sourceTrace.localeCompare(b.sourceTrace);
}

function buildSessionTimelineTree(sessionId: string, sessions: CcSession[]): ExperienceTimelineTree {
  const mainSession = sessions.find((session) => session.traceRole === 'main')
    ?? sessions.find((session) => session.traceRole === 'standalone');
  const main = mainSession ? buildTimelineWindow(mainSession, 0, mainSession.records.length) : [];
  const branches = sessions
    .filter((session) => !mainSession || session !== mainSession)
    .map((session): ExperienceTimelineBranch => {
      const events = buildTimelineWindow(session, 0, session.records.length);
      const attachTo = inferSubagentAttachment(main, session);
      return {
        id: hashParts('timeline-branch', session.sourcePath),
        label: session.traceLabel ?? session.sourcePath.split('/').pop() ?? 'subagent',
        sourceTrace: session.sourcePath,
        traceRole: session.traceRole ?? 'subagent',
        attachTo,
        events,
      };
    });
  return {
    sessionId,
    main,
    branches,
  };
}

function inferSubagentAttachment(
  mainEvents: ExperienceTimelineEvent[],
  branchSession: CcSession,
): ExperienceTimelineBranch['attachTo'] | undefined {
  const startedAt = branchSession.startTimestamp;
  const taskUses = mainEvents.filter((event) => event.kind === 'tool_use' && /^(Task|Agent|Skill)$/i.test(event.toolName ?? ''));
  const candidates = startedAt
    ? taskUses.filter((event) => !event.timestamp || event.timestamp <= startedAt)
    : taskUses;
  const event = candidates.at(-1) ?? taskUses.at(-1);
  if (!event) return undefined;
  return {
    sourceTrace: event.sourceTrace,
    messageIndex: event.messageIndex,
    toolUseId: event.toolUseId,
    label: event.toolName,
  };
}

function minDefined(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? Math.min(...filtered) : undefined;
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? Math.max(...filtered) : undefined;
}

function minString(values: Array<string | undefined>): string | undefined {
  const filtered = values.filter((value): value is string => Boolean(value));
  return filtered.length > 0 ? filtered.reduce((min, value) => value < min ? value : min, filtered[0]) : undefined;
}

function maxString(values: Array<string | undefined>): string | undefined {
  const filtered = values.filter((value): value is string => Boolean(value));
  return filtered.length > 0 ? filtered.reduce((max, value) => value > max ? value : max, filtered[0]) : undefined;
}

function uniqueEvidenceRefs(refs: ExperienceEvidenceRef[]): ExperienceEvidenceRef[] {
  const byId = new Map<string, ExperienceEvidenceRef>();
  for (const ref of refs) {
    byId.set(ref.id, ref);
  }
  return Array.from(byId.values());
}

function inferUserGoal(userRefs: ExperienceTimelineEvent[]): string | undefined {
  const first = userRefs.find((ref) => ref.snippet && !ref.snippet.includes('tool_result'));
  return snippet(first?.snippet, 180);
}

export function findUserCorrectionMatches(value: string): TextMatchRange[] {
  const ranges: TextMatchRange[] = [];
  for (const term of PHRASE_USER_CORRECTION_TERMS) {
    pushTermMatches(value, term, ranges, false);
  }
  for (const term of BOUNDED_USER_CORRECTION_TERMS) {
    pushTermMatches(value, term, ranges, true);
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function hasUserCorrectionSignal(value: string): boolean {
  return findUserCorrectionMatches(value).length > 0;
}

export function findUserGoalShiftMatches(value: string): TextMatchRange[] {
  const ranges: TextMatchRange[] = [];
  for (const term of USER_GOAL_SHIFT_TERMS) {
    pushTermMatches(value, term, ranges, false);
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function hasUserGoalShiftSignal(value: string): boolean {
  return findUserGoalShiftMatches(value).length > 0;
}

export function findNegativeFeedbackMatches(value: string): TextMatchRange[] {
  const ranges: TextMatchRange[] = [];
  for (const term of [...NEGATIVE_FEEDBACK_TERMS].sort((a, b) => b.length - a.length)) {
    pushTermMatches(value, term, ranges, false);
  }
  for (const term of [...BOUNDED_NEGATIVE_FEEDBACK_TERMS].sort((a, b) => b.length - a.length)) {
    pushTermMatches(value, term, ranges, true);
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function hasNegativeFeedbackSignal(value: string): boolean {
  return findNegativeFeedbackMatches(value).length > 0;
}

export function findPositiveFeedbackMatches(value: string): TextMatchRange[] {
  const ranges: TextMatchRange[] = [];
  for (const term of POSITIVE_FEEDBACK_TERMS) {
    pushTermMatches(value, term, ranges, false, true);
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export function hasPositiveFeedbackSignal(value: string): boolean {
  return findPositiveFeedbackMatches(value).length > 0;
}

function pushTermMatches(value: string, term: string, ranges: TextMatchRange[], requireBoundary: boolean, caseInsensitive = false): void {
  const haystack = caseInsensitive ? value.toLowerCase() : value;
  const needle = caseInsensitive ? term.toLowerCase() : term;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const end = index + needle.length;
    if ((!requireBoundary || (isTextBoundary(value[index - 1]) && isTextBoundary(value[end])))
      && !ranges.some((range) => index < range.end && end > range.start)) {
      ranges.push({ start: index, end });
    }
    index = haystack.indexOf(needle, index + needle.length);
  }
}

function isTextBoundary(value: string | undefined): boolean {
  if (value === undefined) return true;
  return TEXT_BOUNDARY_CHARS.has(value);
}

function isSkillContextRecord(record: CcUserRecord, text: string): boolean {
  const meta = record as CcUserRecord & { isMeta?: unknown; sourceToolUseID?: unknown };
  if (meta.isMeta === true && typeof meta.sourceToolUseID === 'string') return true;
  return /^Base directory for this skill:\s+.+(?:\n| )#\s+[a-z0-9][\w.-]*/i.test(text);
}

function isRuntimeContextRecord(record: CcUserRecord, text: string): boolean {
  const meta = record as CcUserRecord & { entrypoint?: unknown; promptId?: unknown; parentUuid?: unknown };
  if (/^Conversation info \(untrusted metadata\):\s*```json/i.test(text)) return true;
  if (meta.entrypoint !== 'sdk-ts' || typeof meta.promptId !== 'string') return false;
  return /^进入.+流程。当前页面已经完成本地工作区恢复/.test(text)
    || /gui-workflow route/.test(text)
    || /当前页面已经完成本地工作区恢复/.test(text);
}

function timestampOf(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const value = (record as { timestamp?: unknown }).timestamp;
  return typeof value === 'string' ? value : undefined;
}

function sourceKindForPath(path: string): ObservationSourceKind {
  if (path.includes('/openclaw') || path.includes('/.openclaw/')) return 'openclaw';
  if (path.endsWith('.jsonl')) return 'claude';
  if (path.endsWith('.log')) return 'markdown_log';
  return 'unknown';
}

function inferEntrypointFromRecords(session: CcSession): string | undefined {
  for (const record of session.records) {
    if (!record || typeof record !== 'object') continue;
    const entrypoint = (record as { entrypoint?: unknown }).entrypoint;
    if (typeof entrypoint === 'string' && entrypoint.trim()) return entrypoint;
  }
  if (session.entrypoint) return session.entrypoint;
  if (session.sourceKind === 'openclaw') return 'openclaw';
  if (session.sourceKind === 'markdown_log') return 'markdown_log';
  if (session.sourcePath.endsWith('.log')) return 'markdown_log';
  return undefined;
}

function snippet(value: unknown, max = 240): string | undefined {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function fullText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const normalized = text.trim();
  return normalized || undefined;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function hashParts(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}
