import { createHash } from 'node:crypto';
import type { ObservationInboxItem, ObservationSourceKind } from './inbox.js';
import {
  buildExperienceProblemPatterns,
  mergeExperienceProblemPatterns,
  type ExperienceProblemPattern,
} from './problem-patterns.js';
import { observationMetricAnnotationVerdict, observationReviewStateKey, type ObservationMetricKey, type ObservationReviewState } from './review-state.js';
import type { CcAssistantRecord, CcRecord, CcSession, CcUserRecord, TraceSourceMetadata } from './trace-source.js';
import type { SkillSegment } from './trace-segmenter.js';
import { extractCommandEnvelopeText, stripCommandEnvelopeText } from './trace-attribution.js';
import { hasAssistantDeliverySignalText, hasUserHardRuleText, isAssistantProgressUpdateText, isScheduledTaskPromptText } from './text-signals.js';
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
export type ExperienceReviewerReportScope = 'single_skill_single_goal' | 'degraded_complex';
export type ExperienceReviewerReportStepStatus = 'ok' | 'attention' | 'unknown';
export type ExperienceReviewerReportFindingLevel = 'attention' | 'possible_false_positive' | 'note';
export type ExperienceReviewerReportFindingSource = 'deterministic_rule' | 'llm_soft' | 'manual';
export type ExperienceSessionStoryNodeKind =
  | 'user_goal'
  | 'skill_invocation'
  | 'subagent_branch'
  | 'tool_execution'
  | 'delivery'
  | 'user_feedback'
  | 'goal_shift';
export type ExperienceSessionStoryAnswerKey = 'goal_satisfaction' | 'declared_behavior_fit' | 'user_feeling';
export type ExperienceSessionStorySkillRole = 'router' | 'executor' | 'mixed' | 'unknown';
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

export interface ExperienceReviewerReportStep {
  order: number;
  label: string;
  status: ExperienceReviewerReportStepStatus;
  text: string;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceReviewerReportFinding {
  id: string;
  judgmentId: string;
  source: ExperienceReviewerReportFindingSource;
  level: ExperienceReviewerReportFindingLevel;
  title: string;
  body: string;
  ruleSource: string;
  ruleVersion: string;
  evidenceRefs: ExperienceEvidenceRef[];
  reviewStateRef: {
    targetType: 'reviewer_judgment';
    targetId: string;
    verdict?: string;
    reason?: string;
    note?: string;
    reviewedAt?: string;
  };
}

export interface ExperienceSessionStoryNode {
  id: string;
  order: number;
  kind: ExperienceSessionStoryNodeKind;
  label: string;
  status: ExperienceReviewerReportStepStatus;
  text: string;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceSessionStoryAnswer {
  key: ExperienceSessionStoryAnswerKey;
  label: string;
  status: ExperienceReviewerReportStepStatus;
  text: string;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceSessionStoryGoalSlice {
  id: string;
  order: number;
  skillNames: string[];
  startTimestamp: string;
  endTimestamp: string;
  reasonCode: ExperienceGoalSliceReasonCode;
  inferredUserGoal?: string;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceSessionStorySubagentDispatch {
  id: string;
  order: number;
  branchId: string;
  label: string;
  sourceTrace: string;
  attachTo?: {
    messageIndex?: number;
    toolUseId?: string;
    label?: string;
  };
  eventCount: number;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceSessionStorySkillLink {
  id: string;
  order: number;
  skillName: string;
  role: ExperienceSessionStorySkillRole;
  invocationIds: string[];
  goalSliceIds: string[];
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceSessionStoryGraphNode {
  id: string;
  label: string;
  kind: ExperienceSessionStoryNodeKind;
  status: ExperienceReviewerReportStepStatus;
  role?: ExperienceSessionStorySkillRole;
  detailNodeId?: string;
}

export interface ExperienceSessionStoryGraphEdge {
  fromId: string;
  toId: string;
  label: string;
}

export interface ExperienceSessionStory {
  schemaVersion: 1;
  summary: string;
  invocationCount: number;
  goalSliceCount: number;
  branchCount: number;
  progressUpdateCount: number;
  finalDeliverySignalCount: number;
  mainlineNodeIds: string[];
  goalSlices: ExperienceSessionStoryGoalSlice[];
  subagentDispatches: ExperienceSessionStorySubagentDispatch[];
  skillLinks: ExperienceSessionStorySkillLink[];
  graph: {
    nodes: ExperienceSessionStoryGraphNode[];
    edges: ExperienceSessionStoryGraphEdge[];
  };
  nodes: ExperienceSessionStoryNode[];
  answers: ExperienceSessionStoryAnswer[];
}

export interface ExperienceReviewerReport {
  schemaVersion: 1;
  mode: 'deterministic_milestone_1' | 'deterministic_session_story';
  generatedAt: string;
  title: string;
  summary: string;
  scope: {
    kind: ExperienceReviewerReportScope;
    reasonCodes: string[];
  };
  chainSteps: ExperienceReviewerReportStep[];
  findings: ExperienceReviewerReportFinding[];
  oneLookMetrics: {
    toolCallCount: number;
    toolFailureCount: number;
    userMessageCount: number;
    userFollowUpCount: number;
    assistantDeliverySignalCount: number;
    assistantProgressUpdateCount: number;
    finalDeliverySignalCount: number;
    traceEventCount: number;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      attribution: 'skill_segment';
    };
  };
  sessionStory: ExperienceSessionStory;
  authorSuggestions: string[];
  traceLinks: ExperienceEvidenceRef[];
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
  sessionGroupKey: string;
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
  sessionStory?: ExperienceSessionStory;
  reviewerReport?: ExperienceReviewerReport;
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
  const sessionGroupsByKey = groupSessionsByExperienceKey(input.sessions);
  const goalSlices: ExperienceGoalSlice[] = [];
  const invocations: ExperienceInvocation[] = [];

  for (const segment of input.segments) {
    if (segment.skillName === 'general') continue;
    const session = sessionsBySourceTrace.get(segment.sourceTrace ?? '') ?? sessionGroupsById.get(segment.sessionId)?.[0];
    const sourceTrace = segment.sourceTrace ?? session?.sourcePath ?? '';
    const sessionGroupKey = session ? experienceSessionGroupKey(session) : `trace:${sourceTrace || segment.sessionId}`;
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
      sessionGroupKey,
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

  const sessions = summarizeExperienceSessions(invocations, sessionGroupsByKey, input.generatedAt, input.reviewState);
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

function experienceSessionGroupKey(session: CcSession): string {
  const logicalId = logicalSessionId(session);
  if (session.traceRole && session.traceRole !== 'standalone' && session.sessionGroupPath) {
    return `group:${session.sessionGroupPath}\u0000${logicalId}`;
  }
  return `trace:${session.sourcePath}`;
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

function groupSessionsByExperienceKey(sessions: CcSession[]): Map<string, CcSession[]> {
  const groups = new Map<string, CcSession[]>();
  for (const session of sessions) {
    const key = experienceSessionGroupKey(session);
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

function isAssistantProgressUpdateEvent(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'assistant_message') return false;
  const text = event.fullText ?? event.snippet ?? '';
  return isAssistantProgressUpdateText(text);
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

function summarizeExperienceSessions(
  invocations: ExperienceInvocation[],
  sessionGroupsByKey: Map<string, CcSession[]>,
  generatedAt: string,
  reviewState?: ObservationReviewState,
): ExperienceSessionSummary[] {
  const byKey = new Map<string, ExperienceInvocation[]>();
  for (const invocation of invocations) {
    const key = `${invocation.skillName}\u0000${invocation.sessionGroupKey}`;
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
    const sessionGroup = sessionGroupsByKey.get(first.sessionGroupKey) ?? [];
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
    const storyInvocations = invocations.filter((invocation) => invocation.sessionGroupKey === first.sessionGroupKey);
    const baseSession: Omit<ExperienceSessionSummary, 'sessionStory' | 'reviewerReport'> = {
      id: hashParts('session', first.skillName, first.sessionGroupKey),
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
    const sessionStory = buildSessionStory(baseSession, storyInvocations);
    const sessionWithStory: ExperienceSessionSummary = {
      ...baseSession,
      sessionStory,
    };
    return {
      ...sessionWithStory,
      reviewerReport: buildReviewerReport(sessionWithStory, group, generatedAt, reviewState, storyInvocations, sessionStory),
    };
  }).sort((a, b) => {
    if (b.reviewPriorityScore !== a.reviewPriorityScore) return b.reviewPriorityScore - a.reviewPriorityScore;
    return b.endTimestamp.localeCompare(a.endTimestamp);
  });
}

const REVIEWER_REPORT_RULE_VERSION = 'reviewer-report.v1';

function buildReviewerReport(
  session: ExperienceSessionSummary,
  invocations: ExperienceInvocation[],
  generatedAt: string,
  reviewState?: ObservationReviewState,
  storyInvocations: ExperienceInvocation[] = invocations,
  sessionStory: ExperienceSessionStory = buildSessionStory(session, storyInvocations),
): ExperienceReviewerReport {
  const indicators = session.indicators;
  const scopeReasons = reviewerScopeReasonCodes(session);
  const scopeKind: ExperienceReviewerReportScope = scopeReasons.length === 0 ? 'single_skill_single_goal' : 'degraded_complex';
  const findings = reviewerFindingsForSession(session, reviewState);
  const attentionCount = findings.filter((finding) => finding.level === 'attention').length;
  const possibleFalsePositiveCount = findings.filter((finding) => finding.level === 'possible_false_positive').length;
  const tokenUsage = sumTokenUsage(invocations);
  const title = reviewerTitle(session, attentionCount, possibleFalsePositiveCount);
  const traceLinks = uniqueEvidenceRefs([
    ...(session.evidenceChain.firstUserMessage ? [session.evidenceChain.firstUserMessage] : []),
    ...(session.evidenceChain.firstToolUse ? [session.evidenceChain.firstToolUse] : []),
    ...(session.evidenceChain.firstToolFailure ? [session.evidenceChain.firstToolFailure] : []),
    ...(session.evidenceChain.lastAssistantMessage ? [session.evidenceChain.lastAssistantMessage] : []),
    ...findings.flatMap((finding) => finding.evidenceRefs),
  ]).slice(0, 10);

  return {
    schemaVersion: 1,
    mode: 'deterministic_session_story',
    generatedAt,
    title,
    summary: reviewerSummary(session, scopeKind, attentionCount, possibleFalsePositiveCount),
    scope: {
      kind: scopeKind,
      reasonCodes: scopeReasons,
    },
    chainSteps: [
      reviewerStep(1, '用户期待', userGoalStepText(session), session.evidenceChain.firstUserMessage ? 'ok' : 'unknown', session.evidenceChain.firstUserMessage ? [session.evidenceChain.firstUserMessage] : []),
      reviewerStep(2, '选择能力', skillSelectionStepText(session), 'ok', [session.evidenceChain.firstSkillContext, session.evidenceChain.firstToolUse].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))),
      reviewerStep(3, '执行流程', executionStepText(session), indicators.toolFailureCount > 0 ? 'attention' : 'ok', session.evidenceChain.firstToolUse ? [session.evidenceChain.firstToolUse] : []),
      reviewerStep(4, '实际产物', deliveryStepText(session), indicators.assistantDeliverySignalCount > 0 ? 'ok' : 'unknown', session.evidenceChain.lastAssistantMessage ? [session.evidenceChain.lastAssistantMessage] : []),
      reviewerStep(5, '用户反馈', userFeedbackStepText(session), userFeedbackStepStatus(session), userFeedbackEvidenceRefs(session)),
    ],
    findings,
      oneLookMetrics: {
      toolCallCount: indicators.toolCallCount,
      toolFailureCount: indicators.toolFailureCount,
      userMessageCount: indicators.userMessageCount,
      userFollowUpCount: indicators.userFollowUpCount,
      assistantDeliverySignalCount: indicators.assistantDeliverySignalCount,
      assistantProgressUpdateCount: assistantProgressUpdateEvents(session).length,
      finalDeliverySignalCount: assistantFinalDeliveryEvents(session).length,
      traceEventCount: session.fullSessionTimeline.length || session.timelinePreview.length,
      tokenUsage: {
        ...tokenUsage,
        attribution: 'skill_segment',
      },
    },
    sessionStory,
    authorSuggestions: reviewerAuthorSuggestions(session, findings),
    traceLinks,
  };
}

function buildSessionStory(session: ExperienceSessionSummary, invocations: ExperienceInvocation[]): ExperienceSessionStory {
  const nodes: ExperienceSessionStoryNode[] = [];
  const push = (
    kind: ExperienceSessionStoryNodeKind,
    label: string,
    status: ExperienceReviewerReportStepStatus,
    text: string,
    evidenceRefs: ExperienceEvidenceRef[] = [],
  ): ExperienceSessionStoryNode => {
    nodes.push({
      id: hashParts('session-story-node', session.id, kind, String(nodes.length), text),
      order: nodes.length + 1,
      kind,
      label,
      status,
      text,
      evidenceRefs: uniqueEvidenceRefs(evidenceRefs).slice(0, 5),
    });
    return nodes[nodes.length - 1];
  };

  const goalSlices = sessionStoryGoalSlices(session, invocations);
  const subagentDispatches = sessionStorySubagentDispatches(session);
  const skillLinks = sessionStorySkillLinks(session, invocations);
  const progressUpdates = assistantProgressUpdateEvents(session);
  const finalDeliveries = assistantFinalDeliveryEvents(session);

  const userGoalNode = push(
    'user_goal',
    '用户提出目标',
    session.evidenceChain.firstUserMessage ? 'ok' : 'unknown',
    goalSlices.length > 1
      ? `识别到 ${goalSlices.length} 个目标段：${goalSlices.map((goal) => goal.inferredUserGoal ?? '未提取到明确目标').slice(0, 3).join('；')}${goalSlices.length > 3 ? '；...' : ''}`
      : session.evidenceChain.firstUserMessage?.snippet
        ? `用户目标：${session.evidenceChain.firstUserMessage.snippet}`
        : '没有看到明确人工用户目标；当前只能按运行证据还原链路。',
    session.evidenceChain.firstUserMessage ? [session.evidenceChain.firstUserMessage] : [],
  );

  const roleSummary = skillLinks.map((link) => `${link.skillName}：${skillRoleLabel(link.role)}`).join('；');
  const invocationText = skillLinks.length > 1
    ? `本次链路识别到 ${skillLinks.length} 个能力：${roleSummary}。`
    : skillLinks[0]
      ? `本次使用能力：${skillLinks[0].skillName}，角色判断：${skillRoleLabel(skillLinks[0].role)}。`
      : `本次使用能力：${session.skillName}。`;
  const invocationNode = push(
    'skill_invocation',
    '能力介入',
    'ok',
    invocationText,
    uniqueEvidenceRefs([session.evidenceChain.firstSkillContext, session.evidenceChain.firstToolUse].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))),
  );

  let subagentNode: ExperienceSessionStoryNode | undefined;
  if (subagentDispatches.length > 0) {
    subagentNode = push(
      'subagent_branch',
      '分支 / 子任务',
      'unknown',
      `检测到 ${subagentDispatches.length} 条分支或子任务执行线；主线和分支已单独列出，仍需要结合原文确认真实委派关系。`,
      subagentDispatches.flatMap((dispatch) => dispatch.evidenceRefs.slice(0, 1)),
    );
  }

  const executionNode = push(
    'tool_execution',
    '执行过程',
    session.indicators.toolFailureCount > 0 ? 'attention' : session.indicators.toolCallCount > 0 ? 'ok' : 'unknown',
    session.indicators.toolCallCount > 0
      ? `执行中看到 ${session.indicators.toolCallCount} 次工具调用${session.indicators.toolFailureCount > 0 ? `，其中失败 ${session.indicators.toolFailureCount} 次` : ''}。`
      : '没有看到明确工具调用；只能根据消息上下文复盘。',
    uniqueEvidenceRefs([
      session.evidenceChain.firstToolUse,
      session.evidenceChain.firstToolFailure,
    ].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))),
  );

  const deliveryNode = push(
    'delivery',
    '交付产物',
    finalDeliveries.length > 0 ? 'ok' : 'attention',
    deliveryStepText(session),
    uniqueEvidenceRefs([
      ...finalDeliveries.slice(-2).map(evidenceRefFromTimeline),
      ...progressUpdates.slice(-2).map(evidenceRefFromTimeline),
      session.evidenceChain.lastAssistantMessage,
    ].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))),
  );

  const feedbackNode = push(
    'user_feedback',
    '用户反馈',
    userFeedbackStepStatus(session),
    userFeedbackStepText(session),
    userFeedbackEvidenceRefs(session),
  );

  if (session.indicators.userGoalShiftCount > 0) {
    push(
      'goal_shift',
      '目标切换',
      'unknown',
      `检测到 ${session.indicators.userGoalShiftCount} 次目标切换信号；这表示后续用户目标可能已变化，不应强行归因给原能力。`,
      userFeedbackEvidenceRefs(session),
    );
  }

  const answers: ExperienceSessionStoryAnswer[] = [
    sessionStoryAnswer('goal_satisfaction', '用户目标有没有被满足', goalSatisfactionStatus(session), goalSatisfactionText(session), [
      session.evidenceChain.firstUserMessage,
      session.evidenceChain.lastAssistantMessage,
      ...userFeedbackEvidenceRefs(session),
    ]),
    sessionStoryAnswer('declared_behavior_fit', '行为是否符合能力用途', declaredBehaviorStatus(session), declaredBehaviorText(session), [
      session.evidenceChain.firstSkillContext,
      session.evidenceChain.firstToolUse,
      session.evidenceChain.firstToolFailure,
    ]),
    sessionStoryAnswer('user_feeling', '用户是否觉得有用或绕路', userFeelingStatus(session), userFeelingText(session), userFeedbackEvidenceRefs(session)),
  ];

  const summary = answers.some((answer) => answer.status === 'attention')
    ? '这次链路存在需要复核的语义节点，建议从红色节点和证据定位开始看。'
    : answers.every((answer) => answer.status === 'ok')
      ? '这次链路从目标、执行到反馈没有命中明显异常信号，可进入常规抽样。'
      : '这次链路已按语义节点展开，但部分结论仍需要人工结合原文判断。';

  return {
    schemaVersion: 1,
    summary,
    invocationCount: invocations.length,
    goalSliceCount: session.goalSliceIds.length,
    branchCount: subagentDispatches.length,
    progressUpdateCount: progressUpdates.length,
    finalDeliverySignalCount: finalDeliveries.length,
    mainlineNodeIds: [
      userGoalNode.id,
      invocationNode.id,
      ...(subagentNode ? [subagentNode.id] : []),
      executionNode.id,
      deliveryNode.id,
      feedbackNode.id,
    ],
    goalSlices,
    subagentDispatches,
    skillLinks,
    graph: sessionStoryGraph(nodes, skillLinks),
    nodes,
    answers,
  };
}

function assistantFinalDeliveryEvents(session: ExperienceSessionSummary): ExperienceTimelineEvent[] {
  return (session.fullSessionTimeline.length > 0 ? session.fullSessionTimeline : session.timelinePreview)
    .filter(isAssistantDeliveryEvent);
}

function assistantProgressUpdateEvents(session: ExperienceSessionSummary): ExperienceTimelineEvent[] {
  return (session.fullSessionTimeline.length > 0 ? session.fullSessionTimeline : session.timelinePreview)
    .filter(isAssistantProgressUpdateEvent);
}

function sessionStoryGoalSlices(session: ExperienceSessionSummary, invocations: ExperienceInvocation[]): ExperienceSessionStoryGoalSlice[] {
  const byId = new Map<string, ExperienceInvocation[]>();
  for (const invocation of invocations) {
    const group = byId.get(invocation.goalSliceId) ?? [];
    group.push(invocation);
    byId.set(invocation.goalSliceId, group);
  }
  return Array.from(byId.entries()).map(([id, group], index) => {
    const timeline = uniqueTimelineEvents(group.flatMap((invocation) => invocation.timeline)).sort(compareTimelineEvents);
    const userEvents = timeline.filter((event) => event.kind === 'user_message');
    const startTimestamp = minString(group.map((invocation) => invocation.startTimestamp)) ?? session.startTimestamp;
    const endTimestamp = maxString(group.map((invocation) => invocation.endTimestamp)) ?? session.endTimestamp;
    const hasGoalShift = userEvents.some((event) => hasUserGoalShiftSignal(event.snippet ?? ''));
    const reasonCode: ExperienceGoalSliceReasonCode = hasGoalShift
      ? 'explicit_user_goal_shift'
      : group.length > 1 ? 'skill_segment_boundary' : 'default_session_slice';
    return {
      id,
      order: index + 1,
      skillNames: unique(group.map((invocation) => invocation.skillName)).sort(),
      startTimestamp,
      endTimestamp,
      reasonCode,
      inferredUserGoal: inferUserGoal(userEvents),
      evidenceRefs: userEvents.slice(0, 3).map(evidenceRefFromTimeline),
    };
  }).sort((a, b) => a.startTimestamp.localeCompare(b.startTimestamp));
}

function sessionStorySubagentDispatches(session: ExperienceSessionSummary): ExperienceSessionStorySubagentDispatch[] {
  const branches = session.timelineTree?.branches ?? [];
  return branches.map((branch, index) => ({
    id: hashParts('session-story-dispatch', session.id, branch.id),
    order: index + 1,
    branchId: branch.id,
    label: branch.label,
    sourceTrace: branch.sourceTrace,
    attachTo: branch.attachTo ? {
      messageIndex: branch.attachTo.messageIndex,
      toolUseId: branch.attachTo.toolUseId,
      label: branch.attachTo.label,
    } : undefined,
    eventCount: branch.events.length,
    evidenceRefs: branch.events.slice(0, 3).map(evidenceRefFromTimeline),
  }));
}

function sessionStorySkillLinks(session: ExperienceSessionSummary, invocations: ExperienceInvocation[]): ExperienceSessionStorySkillLink[] {
  const bySkill = new Map<string, ExperienceInvocation[]>();
  for (const invocation of invocations) {
    const group = bySkill.get(invocation.skillName) ?? [];
    group.push(invocation);
    bySkill.set(invocation.skillName, group);
  }
  return Array.from(bySkill.entries()).map(([skillName, group], index) => {
    const role = inferSkillRole(group, invocations, session);
    return {
      id: hashParts('session-story-skill-link', session.id, skillName),
      order: index + 1,
      skillName,
      role,
      invocationIds: group.map((invocation) => invocation.id),
      goalSliceIds: unique(group.map((invocation) => invocation.goalSliceId)),
      evidenceRefs: uniqueEvidenceRefs(group.flatMap((invocation) => [
        invocation.evidenceChain.firstSkillContext,
        invocation.evidenceChain.firstToolUse,
        ...routingEvidenceEvents(invocation).map(evidenceRefFromTimeline),
      ].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref)))).slice(0, 5),
    };
  }).sort((a, b) => a.order - b.order);
}

function inferSkillRole(group: ExperienceInvocation[], allInvocations: ExperienceInvocation[], session: ExperienceSessionSummary): ExperienceSessionStorySkillRole {
  const hasRoutingSignal = group.some((invocation) => routingEvidenceEvents(invocation).length > 0);
  const hasBranchDispatch = (session.timelineTree?.branches.length ?? 0) > 0 && group.some((invocation) =>
    invocation.timeline.some((event) => event.kind === 'tool_use' && /^(Task|Agent|Skill)$/i.test(event.toolName ?? ''))
  );
  const hasExecutionSignal = group.some((invocation) =>
    invocation.timeline.some((event) => event.kind === 'tool_use' && !/^(Task|Agent|Skill)$/i.test(event.toolName ?? ''))
  );
  if ((hasRoutingSignal || hasBranchDispatch) && allInvocations.length > group.length) return hasExecutionSignal ? 'mixed' : 'router';
  if (hasRoutingSignal || hasBranchDispatch) return 'router';
  if (hasExecutionSignal) return 'executor';
  return 'unknown';
}

function routingEvidenceEvents(invocation: ExperienceInvocation): ExperienceTimelineEvent[] {
  return invocation.timeline.filter((event) => {
    if (event.kind !== 'assistant_message' && event.kind !== 'tool_use') return false;
    const text = event.fullText ?? event.snippet ?? '';
    return /子\s*Claude|subagent|子任务|分发|委派|调用.+skill|走\s*`?[\w-]+`?\s*skill|\/consult|task-runner/i.test(text);
  }).slice(0, 3);
}

function skillRoleLabel(role: ExperienceSessionStorySkillRole): string {
  if (role === 'router') return '路由';
  if (role === 'executor') return '执行';
  if (role === 'mixed') return '路由 + 执行';
  return '未确认';
}

function sessionStoryGraph(
  nodes: ExperienceSessionStoryNode[],
  skillLinks: ExperienceSessionStorySkillLink[],
): ExperienceSessionStory['graph'] {
  const graphNodes: ExperienceSessionStoryGraphNode[] = nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    status: node.status,
    detailNodeId: node.id,
  }));
  for (const link of skillLinks) {
    graphNodes.push({
      id: link.id,
      label: `${link.skillName}（${skillRoleLabel(link.role)}）`,
      kind: 'skill_invocation',
      status: link.role === 'unknown' ? 'unknown' : 'ok',
      role: link.role,
    });
  }
  const edges: ExperienceSessionStoryGraphEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    edges.push({ fromId: nodes[index - 1].id, toId: nodes[index].id, label: '下一步' });
  }
  const goalNode = nodes.find((node) => node.kind === 'user_goal');
  const executionNode = nodes.find((node) => node.kind === 'tool_execution');
  if (goalNode && executionNode) {
    for (const link of skillLinks) {
      edges.push({ fromId: goalNode.id, toId: link.id, label: '触发' });
      edges.push({ fromId: link.id, toId: executionNode.id, label: skillRoleLabel(link.role) });
    }
  }
  return { nodes: graphNodes, edges };
}

function sessionStoryAnswer(
  key: ExperienceSessionStoryAnswerKey,
  label: string,
  status: ExperienceReviewerReportStepStatus,
  text: string,
  evidenceRefs: Array<ExperienceEvidenceRef | undefined>,
): ExperienceSessionStoryAnswer {
  return {
    key,
    label,
    status,
    text,
    evidenceRefs: uniqueEvidenceRefs(evidenceRefs.filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))).slice(0, 5),
  };
}

function goalSatisfactionStatus(session: ExperienceSessionSummary): ExperienceReviewerReportStepStatus {
  if (session.indicators.negativeFeedbackCount > 0 || session.indicators.userCorrectionCount > 0 || session.indicators.userInterruptionCount > 0) return 'attention';
  if (session.indicators.assistantDeliverySignalCount > 0 && session.indicators.userGoalShiftCount === 0) return 'ok';
  return 'unknown';
}

function goalSatisfactionText(session: ExperienceSessionSummary): string {
  if (session.indicators.negativeFeedbackCount > 0 || session.indicators.userCorrectionCount > 0) {
    return '用户后续出现纠正或负向反馈，不能直接认为原目标已满足。';
  }
  if (session.indicators.userInterruptionCount > 0) return '用户中断了执行链路，需要复核是否绕路或执行过长。';
  if (session.indicators.assistantDeliverySignalCount > 0) return '看到交付信号，且没有命中纠正/负向反馈；可暂按“可能满足”进入抽样复核。';
  return '没有看到最后交付产物，无法判断用户目标是否满足。';
}

function declaredBehaviorStatus(session: ExperienceSessionSummary): ExperienceReviewerReportStepStatus {
  if (session.indicators.toolFailureCount > 0) return 'attention';
  if (session.evidenceChain.firstSkillContext || session.evidenceChain.firstToolUse) return 'ok';
  return 'unknown';
}

function declaredBehaviorText(session: ExperienceSessionSummary): string {
  if (session.indicators.toolFailureCount > 0) return '执行中出现工具失败，需要结合定义链路里的规则/流程检测结果复核是否偏离能力声明。';
  if (session.evidenceChain.firstSkillContext || session.evidenceChain.firstToolUse) return '已看到能力上下文或工具执行证据；是否完全符合声明，需要结合定义链路的规则/流程检测结果看。';
  return '没有足够能力上下文或工具证据，无法判断行为是否符合声明用途。';
}

function userFeelingStatus(session: ExperienceSessionSummary): ExperienceReviewerReportStepStatus {
  if (session.indicators.negativeFeedbackCount > 0 || session.indicators.userCorrectionCount > 0 || session.indicators.userInterruptionCount > 0) return 'attention';
  if (session.indicators.positiveFeedbackCount > 0) return 'ok';
  if (session.indicators.userFollowUpCount > 0 || session.indicators.userGoalShiftCount > 0) return 'unknown';
  return 'unknown';
}

function userFeelingText(session: ExperienceSessionSummary): string {
  if (session.indicators.negativeFeedbackCount > 0) return '看到负向反馈，用户可能失望或认为结果不可用。';
  if (session.indicators.userCorrectionCount > 0) return '看到用户纠正，用户可能认为理解或交付方向有偏差。';
  if (session.indicators.userInterruptionCount > 0) return '看到人工中断，用户可能认为执行绕路或耗时过长。';
  if (session.indicators.positiveFeedbackCount > 0) return '看到正向反馈，说明这次能力输出可能对用户有帮助。';
  if (session.indicators.userGoalShiftCount > 0) return '看到目标切换，用户可能切走到新目标；不直接等同于能力失败。';
  if (session.indicators.userFollowUpCount > 0) return '看到追问/补充，但没有明确正负反馈；需要结合上下文判断是否有用或绕路。';
  return '没有看到明确正向、负向、纠正、中断或放弃信号。';
}

function reviewerScopeReasonCodes(session: ExperienceSessionSummary): string[] {
  const reasons: string[] = [];
  if (session.invocationIds.length !== 1) reasons.push('multiple_invocations');
  if (session.goalSliceIds.length !== 1) reasons.push('multiple_goal_slices');
  if ((session.timelineTree?.branches.length ?? 0) > 0) reasons.push('subagent_branches_present');
  if (session.pluginNames.length > 1 || session.commandNames.length > 1) reasons.push('multiple_skill_entrypoints');
  return reasons;
}

function reviewerStep(
  order: number,
  label: string,
  text: string,
  status: ExperienceReviewerReportStepStatus,
  evidenceRefs: ExperienceEvidenceRef[] = [],
): ExperienceReviewerReportStep {
  return {
    order,
    label,
    status,
    text,
    evidenceRefs: uniqueEvidenceRefs(evidenceRefs).slice(0, 4),
  };
}

function userGoalStepText(session: ExperienceSessionSummary): string {
  const goal = session.evidenceChain.firstUserMessage?.snippet;
  if (!goal) return '没有看到明确人工用户目标；当前只能按运行证据做常规复盘。';
  return `用户目标：${goal}`;
}

function skillSelectionStepText(session: ExperienceSessionSummary): string {
  const entrypoint = session.commandNames.length > 0 ? `，入口 ${session.commandNames.join('、')}` : session.entrypoint ? `，入口 ${session.entrypoint}` : '';
  return `本次使用的能力：${session.skillName}${entrypoint}。`;
}

function executionStepText(session: ExperienceSessionSummary): string {
  const failures = session.indicators.toolFailureCount > 0 ? `，其中失败 ${session.indicators.toolFailureCount} 次` : '';
  return `执行中看到 ${session.indicators.toolCallCount} 次工具调用${failures}。`;
}

function deliveryStepText(session: ExperienceSessionSummary): string {
  if (session.indicators.assistantDeliverySignalCount > 0) {
    return `看到 ${session.indicators.assistantDeliverySignalCount} 次可能是最后交付产物的回复；仍需下钻确认具体产物。`;
  }
  return '没有发现最后交付产物；当前不能把过程进展当成完成。';
}

function userFeedbackStepText(session: ExperienceSessionSummary): string {
  const parts = [
    session.indicators.userFollowUpCount > 0 ? `追问/补充 ${session.indicators.userFollowUpCount} 次` : '',
    session.indicators.userCorrectionCount > 0 ? `纠正 ${session.indicators.userCorrectionCount} 次` : '',
    session.indicators.negativeFeedbackCount > 0 ? `负向反馈 ${session.indicators.negativeFeedbackCount} 次` : '',
    session.indicators.positiveFeedbackCount > 0 ? `正向反馈 ${session.indicators.positiveFeedbackCount} 次` : '',
    session.indicators.userGoalShiftCount > 0 ? `目标切换 ${session.indicators.userGoalShiftCount} 次` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `用户反馈信号：${parts.join('，')}。` : '原始记录里没有看到人工追问、纠正、负向反馈或目标切换。';
}

function userFeedbackStepStatus(session: ExperienceSessionSummary): ExperienceReviewerReportStepStatus {
  if (session.indicators.userCorrectionCount > 0 || session.indicators.negativeFeedbackCount > 0 || session.indicators.userInterruptionCount > 0) return 'attention';
  if (session.indicators.userFollowUpCount > 0 || session.indicators.userGoalShiftCount > 0) return 'unknown';
  return 'ok';
}

function userFeedbackEvidenceRefs(session: ExperienceSessionSummary): ExperienceEvidenceRef[] {
  return uniqueEvidenceRefs(session.ruleFindings
    .filter((finding) => finding.code === 'user_correction_seen' || finding.code === 'negative_feedback_seen' || finding.code === 'positive_feedback_seen' || finding.code === 'user_goal_shift_seen' || finding.code === 'user_interruption_seen')
    .flatMap((finding) => finding.evidenceRefs)).slice(0, 5);
}

function reviewerFindingsForSession(session: ExperienceSessionSummary, reviewState?: ObservationReviewState): ExperienceReviewerReportFinding[] {
  const findings: ExperienceReviewerReportFinding[] = [];
  const push = (
    level: ExperienceReviewerReportFindingLevel,
    title: string,
    body: string,
    ruleSource: string,
    evidenceRefs: ExperienceEvidenceRef[] = [],
  ): void => {
    const id = hashParts('reviewer-finding', session.id, ruleSource, title);
    const judgmentId = hashParts('reviewer-judgment', session.id, ruleSource, title, evidenceRefs.map((ref) => ref.id).join('|'));
    const reviewEntry = reviewState?.entries[observationReviewStateKey('reviewer_judgment', judgmentId)];
    findings.push({
      id,
      judgmentId,
      source: 'deterministic_rule',
      level,
      title,
      body,
      ruleSource,
      ruleVersion: REVIEWER_REPORT_RULE_VERSION,
      evidenceRefs: uniqueEvidenceRefs(evidenceRefs).slice(0, 5),
      reviewStateRef: {
        targetType: 'reviewer_judgment',
        targetId: judgmentId,
        ...(reviewEntry?.verdict ? { verdict: reviewEntry.verdict } : {}),
        ...(reviewEntry?.reason ? { reason: reviewEntry.reason } : {}),
        ...(reviewEntry?.note ? { note: reviewEntry.note } : {}),
        ...(reviewEntry?.reviewedAt ? { reviewedAt: reviewEntry.reviewedAt } : {}),
      },
    });
  };
  const findingRefs = (code: ExperienceRuleFindingCode): ExperienceEvidenceRef[] =>
    session.ruleFindings.filter((finding) => finding.code === code).flatMap((finding) => finding.evidenceRefs);

  if (session.indicators.toolFailureCount > 0) {
    push(
      'attention',
      `工具执行失败 × ${session.indicators.toolFailureCount}`,
      '本次能力执行过程中出现工具失败，需要复核失败是否已恢复，以及是否需要补执行流程避免重复试错。',
      'tool_error_recovery',
      findingRefs('tool_failure_seen'),
    );
  }
  if (session.indicators.assistantDeliverySignalCount === 0) {
    push(
      'attention',
      '没有发现最后交付产物',
      '当前窗口里没有看到最后交付产物；不能把过程进展直接当成完成。',
      'final_delivery_absent',
      session.evidenceChain.lastAssistantMessage ? [session.evidenceChain.lastAssistantMessage] : [],
    );
  }
  if (session.indicators.userCorrectionCount > 0) {
    push(
      'attention',
      `用户纠正 × ${session.indicators.userCorrectionCount}`,
      '人工用户在能力执行链路中出现纠正信号，说明交付或理解可能与用户期待存在偏差。',
      'user_correction',
      findingRefs('user_correction_seen'),
    );
  }
  if (session.indicators.userInterruptionCount > 0) {
    push(
      'attention',
      `人工中断 × ${session.indicators.userInterruptionCount}`,
      '用户主动中断了当前执行，需要复核是否发生绕路、误用工具或执行过长。',
      'user_interruption',
      findingRefs('user_interruption_seen'),
    );
  }
  if (session.indicators.negativeFeedbackCount > 0) {
    push(
      'attention',
      `负向反馈 × ${session.indicators.negativeFeedbackCount}`,
      '人工用户出现明确负向表达，需要复核这次能力是否满足原始目标。',
      'negative_feedback',
      findingRefs('negative_feedback_seen'),
    );
  }
  if (session.indicators.hardRuleTextHitCount > 0) {
    push(
      'note',
      `用户硬性要求 × ${session.indicators.hardRuleTextHitCount}`,
      '用户提出了临时硬性要求；如果同类要求反复出现，可以考虑沉淀为能力规则。',
      'user_hard_rule',
      findingRefs('hard_rule_seen'),
    );
  }
  if (reviewerScopeReasonCodes(session).length > 0) {
    push(
      'note',
      '复杂链路降级展示',
      '本次不是严格的 1 次会话 × 1 个目标 × 1 个能力场景。当前先做通用展示，不强行拆分多能力、子任务或目标切换。',
      'complex_scope_degraded',
      [],
    );
  }
  if (findings.length === 0) {
    push(
      'note',
      '未命中优先问题信号',
      '基于固定规则，没有看到需要优先复核的纠正、中断、负向反馈、工具失败或交付缺失信号。',
      'no_priority_signal',
      [],
    );
  }
  return findings;
}

function reviewerTitle(session: ExperienceSessionSummary, attentionCount: number, possibleFalsePositiveCount: number): string {
  const suffix = possibleFalsePositiveCount > 0 ? ` · ${possibleFalsePositiveCount} 项疑似误判` : '';
  if (attentionCount > 0) return `${session.skillName} · 需要复核 · ${attentionCount} 项要看一眼${suffix}`;
  if (session.indicators.assistantDeliverySignalCount > 0) return `${session.skillName} · 看起来已交付 · 常规抽样${suffix}`;
  return `${session.skillName} · 常规抽样 · 未见高优先级信号${suffix}`;
}

function reviewerSummary(
  session: ExperienceSessionSummary,
  scopeKind: ExperienceReviewerReportScope,
  attentionCount: number,
  possibleFalsePositiveCount: number,
): string {
  const scopeText = scopeKind === 'single_skill_single_goal'
    ? '本次属于单个能力 / 单个目标报告范围。'
    : '本次是复杂链路，当前先做降级展示，不强行拆分语义分支。';
  const reviewText = attentionCount > 0
    ? `发现 ${attentionCount} 条事实层复核点。`
    : '没有发现优先级较高的事实层复核点。';
  const falsePositiveText = possibleFalsePositiveCount > 0 ? `另有 ${possibleFalsePositiveCount} 条疑似误判需要人工确认。` : '';
  return [scopeText, reviewText, falsePositiveText].filter(Boolean).join(' ');
}

function reviewerAuthorSuggestions(session: ExperienceSessionSummary, findings: ExperienceReviewerReportFinding[]): string[] {
  const suggestions: string[] = [];
  if (findings.some((finding) => finding.ruleSource === 'final_delivery_absent')) {
    suggestions.push('补充明确的产物交付表达或交付标记，避免过程进展被当成完成。');
  }
  if (findings.some((finding) => finding.ruleSource === 'tool_error_recovery')) {
    suggestions.push('复查失败工具调用前后的执行流程，必要时把稳定路径写入能力说明文档。');
  }
  if (session.indicators.hardRuleTextHitCount > 0) {
    suggestions.push('把反复出现的用户硬性要求沉淀为能力规则，并在后续观测中追踪是否减少纠偏。');
  }
  if (session.indicators.userCorrectionCount > 0 || session.indicators.negativeFeedbackCount > 0) {
    suggestions.push('优先打开原始片段，确认用户纠正/负向反馈发生在交付前还是交付后。');
  }
  if (reviewerScopeReasonCodes(session).length > 0) {
    suggestions.push('复杂链路暂按降级报告处理；后续再拆多能力、子任务或目标切换。');
  }
  if (suggestions.length === 0) suggestions.push('进入常规抽样池，保留 evidenceRef 以便人工抽查。');
  return suggestions;
}

function sumTokenUsage(invocations: ExperienceInvocation[]): Omit<ExperienceReviewerReport['oneLookMetrics']['tokenUsage'], 'attribution'> {
  return invocations.reduce((sum, invocation) => ({
    inputTokens: sum.inputTokens + (invocation.metrics.inputTokens ?? 0),
    outputTokens: sum.outputTokens + (invocation.metrics.outputTokens ?? 0),
    cacheReadTokens: sum.cacheReadTokens + (invocation.metrics.cacheReadTokens ?? 0),
    cacheCreationTokens: sum.cacheCreationTokens + (invocation.metrics.cacheCreationTokens ?? 0),
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
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
