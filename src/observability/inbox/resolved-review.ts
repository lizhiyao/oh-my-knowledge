import type {
  ExperienceChecklistContribution,
  ExperienceChecklistItem,
  ExperienceChecklistItemStatus,
  ExperienceReviewPriority,
  ExperienceRuntimeSkillType,
  ExperienceSessionStory,
  ExperienceSessionStoryAnswer,
  ExperienceSessionStoryAnswerKey,
} from '../experience.js';
import type { ObservationReviewState, ObservationReviewTargetType } from './review-state.js';
import { observationReviewStateKey } from './review-state.js';
import type { LlmEnhancedChecklistStatus, LlmEnhancedSkillType, RuntimeNodeVerdict, RuntimeStandardNodeKind, SkillLlmEnhancedReviewSections, SkillLlmTypeSpecificChecklistItem } from '../soft-standards/index.js';

export interface ResolveObservationReviewSessionOptions {
  session: {
    id: string;
    skillName: string;
    reviewPriority: ExperienceReviewPriority;
    sessionStory?: {
      answers?: ExperienceSessionStoryAnswer[];
      episodes?: ExperienceSessionStory['episodes'];
    };
  };
  enhancedReview?: SkillLlmEnhancedReviewSections;
  reviewState: ObservationReviewState;
}

export interface ResolvedObservationReviewSession {
  priority: ExperienceReviewPriority;
  answers: ExperienceSessionStoryAnswer[];
  reviewerSummary?: string;
  ownerSuggestions: ResolvedOwnerSuggestion[];
  skillType?: LlmEnhancedSkillType;
  skillTypeSource?: 'frontmatter' | 'llm' | 'trace' | 'unknown';
  typeSpecificChecklist: ExperienceChecklistItem[];
  typeSpecificSummary?: string;
  source: 'manual' | 'llm' | 'deterministic';
}

export interface ResolvedOwnerSuggestion {
  title: string;
  body?: string;
  acceptanceCriteria?: string;
  checklistItemKey?: string;
  checklistItemLabel?: string;
}

export function resolveObservationReviewSession(options: ResolveObservationReviewSessionOptions): ResolvedObservationReviewSession {
  const { session, enhancedReview, reviewState } = options;
  const hasSessionManualReview = Boolean(reviewState.entries[observationReviewStateKey('experience_session', session.id)]);
  const deterministicAnswers = session.sessionStory?.answers ?? [];
  const llmAssessment = enhancedReview?.runtimeAssessment;
  const hasLlmEnhancedReview = Boolean(llmAssessment || enhancedReview?.typeSpecificAssessment?.checklist?.length);
  const skillTypeResolution = resolveSkillType(session, enhancedReview);
  const source: ResolvedObservationReviewSession['source'] = hasSessionManualReview
    ? 'manual'
    : hasLlmEnhancedReview
      ? 'llm'
      : 'deterministic';
  return {
    priority: resolvePriority(session.reviewPriority, enhancedReview, hasSessionManualReview, session),
    answers: resolveAnswers({
      sessionId: session.id,
      skillName: session.skillName,
      deterministicAnswers,
      enhancedReview,
      resolvedSkillType: skillTypeResolution.skillType,
      reviewState,
    }),
    reviewerSummary: enhancedReview?.reviewerSummary,
    ownerSuggestions: ownerSuggestionTexts(enhancedReview, skillTypeResolution.skillType),
    skillType: skillTypeResolution.skillType,
    skillTypeSource: skillTypeResolution.source,
    typeSpecificChecklist: typeSpecificChecklistItems(enhancedReview, skillTypeResolution.skillType),
    typeSpecificSummary: enhancedReview?.typeSpecificAssessment?.summary,
    source,
  };
}

interface ResolvedSkillTypeResult {
  skillType?: LlmEnhancedSkillType;
  source: 'frontmatter' | 'llm' | 'trace' | 'unknown';
}

function resolveSkillType(
  session: ResolveObservationReviewSessionOptions['session'],
  enhancedReview?: SkillLlmEnhancedReviewSections,
): ResolvedSkillTypeResult {
  const segmentTypes = skillSegmentTypes(session);
  if (segmentTypes.declared) return { skillType: segmentTypes.declared, source: 'frontmatter' };
  const llm = normalizeResolvedSkillType(enhancedReview?.skillType);
  if (llm) return { skillType: llm, source: 'llm' };
  const trace = segmentTypes.trace;
  if (trace) return { skillType: trace, source: 'trace' };
  return { skillType: 'unknown', source: 'unknown' };
}

function skillSegmentTypes(session: ResolveObservationReviewSessionOptions['session']): {
  declared?: LlmEnhancedSkillType;
  trace?: LlmEnhancedSkillType;
} {
  const segments = (session.sessionStory?.episodes ?? [])
    .flatMap((episode) => episode.skillSegments ?? [])
    .filter((segment) => segment.skillName === session.skillName);
  const declared = segments.map((segment) => normalizeResolvedSkillType(segment.declaredSkillType)).find(Boolean);
  const trace = segments
    .map((segment) => normalizeResolvedSkillType(segment.traceInferredSkillType ?? (segment.skillTypeSource === 'trace' ? segment.skillType : undefined)))
    .find(Boolean);
  return { declared, trace };
}

function normalizeResolvedSkillType(value?: ExperienceRuntimeSkillType | LlmEnhancedSkillType): LlmEnhancedSkillType | undefined {
  if (value === 'router' || value === 'delegation' || value === 'executor' || value === 'advisory' || value === 'workflow_owner') return value;
  return undefined;
}

export function resolveObservationReviewPriority(
  priority: ExperienceReviewPriority,
  enhancedReview: SkillLlmEnhancedReviewSections | undefined,
  hasManualReview: boolean,
): ExperienceReviewPriority {
  return resolvePriority(priority, enhancedReview, hasManualReview);
}

function resolvePriority(
  priority: ExperienceReviewPriority,
  enhancedReview: SkillLlmEnhancedReviewSections | undefined,
  hasManualReview: boolean,
  session?: ResolveObservationReviewSessionOptions['session'],
  suppressTypeSpecific = false,
): ExperienceReviewPriority {
  if (hasManualReview) return priority;
  const attributionPriority = priorityFromEpisodeAttribution(session);
  if (attributionPriority === 'review_first') return 'review_first';
  const assessment = enhancedReview?.runtimeAssessment;
  const typeChecklist = suppressTypeSpecific ? [] : enhancedReview?.typeSpecificAssessment?.checklist ?? [];
  const nodeAssessments = enhancedReview ? runtimeNodeChecklistItems(enhancedReview) : [];
  if (!assessment && typeChecklist.length === 0 && nodeAssessments.length === 0) return attributionPriority ?? priority;
  const attributionMode = episodeAttributionMode(session);
  if (typeChecklist.some((item) => item.status === 'failed' || item.status === 'degraded')
    || nodeAssessments.some((item) => item.status === 'failed' || item.status === 'degraded')) {
    if (attributionMode === 'downstream_only') return maxPriority(priority, 'sample_review');
    return 'review_first';
  }
  const hasFailed = assessment && (assessment.goalSatisfaction === 'failed'
    || assessment.declaredBehaviorFit === 'failed'
    || assessment.artifactGoalMatch === 'failed'
    || assessment.userFeeling === 'negative'
    || assessment.userFeeling === 'frustrated');
  if (hasFailed) {
    if (attributionMode === 'downstream_only') return maxPriority(priority, 'sample_review');
    return 'review_first';
  }
  const hasUnknown = (assessment && (assessment.goalSatisfaction === 'unknown'
    || assessment.declaredBehaviorFit === 'unknown'
    || assessment.artifactGoalMatch === 'unknown'
    || assessment.userFeeling === 'neutral'))
    || typeChecklist.some((item) => item.status === 'unknown')
    || nodeAssessments.some((item) => item.status === 'unknown');
  if (hasUnknown && priority === 'routine_sample') return maxPriority(attributionPriority ?? priority, 'sample_review');
  return attributionPriority ? maxPriority(priority, attributionPriority) : priority;
}

function episodeAttributionMode(session?: ResolveObservationReviewSessionOptions['session']): 'primary' | 'downstream_only' | 'context_or_none' {
  const signals = session?.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [];
  const currentSkillAttributions = signals.flatMap((signal) =>
    (signal.canonicalAttributions ?? signal.attributions ?? []).filter((attribution) => attribution.skillName === session?.skillName)
  );
  if (currentSkillAttributions.some((attribution) => attribution.attributionRole === 'primary_fault')) return 'primary';
  if (currentSkillAttributions.some((attribution) => attribution.attributionRole === 'downstream_related')) return 'downstream_only';
  return 'context_or_none';
}

function priorityFromEpisodeAttribution(session?: ResolveObservationReviewSessionOptions['session']): ExperienceReviewPriority | undefined {
  const signals = session?.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [];
  const currentSkillSignals = signals.filter((signal) =>
    (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) => attribution.skillName === session?.skillName && attribution.attributionRole === 'primary_fault')
  );
  if (currentSkillSignals.some((signal) => signal.type === 'correction' || signal.type === 'frustration' || signal.type === 'interruption')) return 'review_first';
  if (currentSkillSignals.length > 0) return 'sample_review';
  return undefined;
}

function maxPriority(a: ExperienceReviewPriority, b: ExperienceReviewPriority): ExperienceReviewPriority {
  const rank: Record<ExperienceReviewPriority, number> = {
    routine_sample: 0,
    sample_review: 1,
    review_first: 2,
  };
  return rank[a] >= rank[b] ? a : b;
}

function resolveAnswers(options: {
  sessionId: string;
  skillName: string;
  deterministicAnswers: ExperienceSessionStoryAnswer[];
  enhancedReview?: SkillLlmEnhancedReviewSections;
  resolvedSkillType?: LlmEnhancedSkillType;
  suppressTypeSpecific?: boolean;
  reviewState: ObservationReviewState;
}): ExperienceSessionStoryAnswer[] {
  const { deterministicAnswers, enhancedReview } = options;
  if (!enhancedReview?.runtimeAssessment && !enhancedReview?.typeSpecificAssessment?.checklist?.length) return deterministicAnswers;
  const baseAnswers = deterministicAnswers.length > 0 ? deterministicAnswers : defaultAnswers();
  return baseAnswers.map((answer) =>
    manualAnswerTouched(options.reviewState, options.sessionId, options.skillName, answer.key)
      ? answer
      : resolveAnswerFromLlm(answer, enhancedReview, options.resolvedSkillType, Boolean(options.suppressTypeSpecific))
  );
}

function defaultAnswers(): ExperienceSessionStoryAnswer[] {
  return [
    defaultAnswer('goal_satisfaction', '用户目标有没有被满足'),
    defaultAnswer('declared_behavior_fit', '行为是否符合能力用途'),
    defaultAnswer('user_feeling', '用户是否觉得有用或绕路'),
  ];
}

function defaultAnswer(key: ExperienceSessionStoryAnswerKey, label: string): ExperienceSessionStoryAnswer {
  return {
    key,
    label,
    status: 'unknown',
    reason: 'unknown_dominant',
    sourceItemKeys: [],
    text: '',
    evidenceRefs: [],
    checklistItems: [],
  };
}

function resolveAnswerFromLlm(
  answer: ExperienceSessionStoryAnswer,
  enhancedReview: SkillLlmEnhancedReviewSections,
  resolvedSkillType?: LlmEnhancedSkillType,
  suppressTypeSpecific = false,
): ExperienceSessionStoryAnswer {
  const assessment = enhancedReview.runtimeAssessment;
  if (!assessment) return answer;
  if (answer.key === 'goal_satisfaction') {
    const status = verdictStatus(assessment.goalSatisfaction);
    const artifactStatus = verdictStatus(assessment.artifactGoalMatch);
    const typeItems = suppressTypeSpecific ? [] : typeSpecificChecklistForAnswer(enhancedReview, 'goal_satisfaction', resolvedSkillType);
    return {
      ...answer,
      status: worstAnswerStatus(status, typeItems),
      reason: reasonForStatus(worstAnswerStatus(status, typeItems)),
      text: enhancedReview.reviewerSummary ?? answer.text,
      checklistItems: [
        checklistItem('llm_goal_satisfaction', `用户目标满足：${verdictLabel(assessment.goalSatisfaction)}`, status === 'ok' ? 'passed' : status === 'attention' ? 'failed' : 'unknown', 'LLM 基于运行证据判断目标是否满足。', 'blocking'),
        checklistItem('llm_artifact_goal_match', `产物对题：${verdictLabel(assessment.artifactGoalMatch)}`, artifactStatus === 'ok' ? 'passed' : artifactStatus === 'attention' ? 'failed' : 'unknown', 'LLM 判断产物是否匹配用户目标。', 'attention'),
        ...typeItems,
      ],
    };
  }
  if (answer.key === 'declared_behavior_fit') {
    const status = verdictStatus(assessment.declaredBehaviorFit);
    const typeItems = suppressTypeSpecific ? [] : typeSpecificChecklistForAnswer(enhancedReview, 'declared_behavior_fit', resolvedSkillType);
    const nodeItems = runtimeNodeChecklistItems(enhancedReview);
    const allItems = [...typeItems, ...nodeItems];
    return {
      ...answer,
      status: worstAnswerStatus(status, allItems),
      reason: reasonForStatus(worstAnswerStatus(status, allItems)),
      text: enhancedReview.reviewerSummary ?? answer.text,
      checklistItems: [
        checklistItem('llm_declared_behavior_fit', `行为符合声明：${verdictLabel(assessment.declaredBehaviorFit)}`, status === 'ok' ? 'passed' : status === 'attention' ? 'failed' : 'unknown', 'LLM 判断运行行为是否符合 skill 声明。', 'blocking'),
        ...allItems,
      ],
    };
  }
  if (answer.key === 'user_feeling') {
    const status = feelingStatus(assessment.userFeeling);
    const signals = enhancedReview.userExperienceSignals;
    const typeItems = suppressTypeSpecific ? [] : typeSpecificChecklistForAnswer(enhancedReview, 'user_feeling', resolvedSkillType);
    return {
      ...answer,
      status: worstAnswerStatus(status, typeItems),
      reason: reasonForStatus(worstAnswerStatus(status, typeItems)),
      text: enhancedReview.reviewerSummary ?? answer.text,
      checklistItems: [
        checklistItem('llm_user_useful', `用户觉得有用：${verdictLabel(signals?.useful)}`, verdictItemStatus(signals?.useful), 'LLM 判断用户是否表现出有用或采纳信号。', 'positive'),
        negativeSignalChecklistItem('llm_user_follow_up', '用户追问', signals?.followUp, 'LLM 判断用户是否继续追问结果、进度或补充上下文。', 'attention'),
        negativeSignalChecklistItem('llm_user_correction', '用户纠正', signals?.correction, 'LLM 判断用户是否明确纠正方向或结果。', 'attention'),
        negativeSignalChecklistItem('llm_user_negative_feedback', '负向反馈', signals?.negativeFeedback, 'LLM 判断用户是否表达不满、否定或失望。', 'attention'),
        negativeSignalChecklistItem('llm_user_interruption', '中断流程', signals?.interruption, 'LLM 判断用户是否中断、停止或放弃当前流程。', 'blocking'),
        negativeSignalChecklistItem('llm_user_frustration', '烦躁/失望', signals?.frustration ?? feelingSignalVerdict(assessment.userFeeling), 'LLM 基于用户反馈、追问和语气判断用户是否烦躁或失望。', 'attention'),
        ...typeItems,
      ],
    };
  }
  return answer;
}

function typeSpecificChecklistForAnswer(
  enhancedReview: SkillLlmEnhancedReviewSections,
  answerKey: ExperienceSessionStoryAnswerKey,
  skillType?: LlmEnhancedSkillType,
): ExperienceChecklistItem[] {
  return (enhancedReview.typeSpecificAssessment?.checklist ?? [])
    .filter((item) => typeSpecificAnswerKey(item.key) === answerKey)
    .map((item) => typeSpecificChecklistItem(item, skillType ?? enhancedReview.skillType));
}

function typeSpecificChecklistItems(enhancedReview?: SkillLlmEnhancedReviewSections, skillType?: LlmEnhancedSkillType): ExperienceChecklistItem[] {
  const items = enhancedReview?.typeSpecificAssessment?.checklist ?? [];
  return items.map((item) => typeSpecificChecklistItem(item, skillType ?? enhancedReview?.skillType));
}

function runtimeNodeChecklistItems(enhancedReview: SkillLlmEnhancedReviewSections): ExperienceChecklistItem[] {
  const runtimeResults = enhancedReview.runtimeNodeResults?.nodes ?? [];
  if (runtimeResults.length > 0) {
    return runtimeResults.slice(0, 12).map((node) => checklistItem(
      `runtime_node_${node.nodeKind}_${node.nodeId}`,
      `${runtimeNodeKindLabel(node.nodeKind)}：${node.title || node.nodeId}`,
      runtimeNodeChecklistStatus(node.status),
      node.reason || '规则层基于 LLM 拆解的 typed signal 匹配运行证据。',
      node.status === 'violated' || node.status === 'degraded' ? 'attention' : 'informational',
    ));
  }
  return (enhancedReview.runtimeNodeAssessment?.nodes ?? []).slice(0, 12).map((node) => checklistItem(
    `legacy_llm_node_${node.nodeKind}_${node.nodeId}`,
    `${node.nodeKind === 'workflowNode' ? '流程节点' : '硬性规则'}：${node.nodeId}`,
    checklistStatus(node.status),
    node.reason ?? '旧版模型节点复核结果。',
    node.status === 'failed' || node.status === 'degraded' ? 'attention' : 'informational',
  ));
}

function runtimeNodeKindLabel(kind: RuntimeStandardNodeKind): string {
  if (kind === 'hardRule') return '硬性规则';
  if (kind === 'workflow') return '流程节点';
  if (kind === 'completion') return '完成标准';
  if (kind === 'artifact') return '产物标准';
  return '阶段';
}

function runtimeNodeChecklistStatus(status: RuntimeNodeVerdict): ExperienceChecklistItemStatus {
  if (status === 'passed') return 'passed';
  if (status === 'missed' || status === 'violated') return 'failed';
  if (status === 'degraded') return 'degraded';
  return 'unknown';
}

function typeSpecificChecklistItem(item: SkillLlmTypeSpecificChecklistItem, skillType?: LlmEnhancedSkillType): ExperienceChecklistItem {
  return checklistItem(
    `llm_type_${item.key}`,
    `${skillTypeLabel(skillType)}：${readableTypeSpecificLabel(item, skillType)}`,
    checklistStatus(item.status),
    item.reason || 'LLM 按 skill 类型判断该项运行表现。',
    typeSpecificContribution(item.key, item.status),
    item.suggestionKey,
  );
}

function readableTypeSpecificLabel(item: SkillLlmTypeSpecificChecklistItem, skillType?: LlmEnhancedSkillType): string {
  const normalized = normalizeChecklistLabel(item.label || item.key);
  const keyLabel = typeSpecificKeyLabel(item.key, skillType);
  const label = keyLabel || normalized || item.key;
  if (item.status === 'passed') return `已确认：${label}`;
  if (item.status === 'failed') return failedTypeSpecificLabel(item.key, label);
  if (item.status === 'degraded') return `证据不足：${label}`;
  if (item.status === 'not_applicable') return `不适用：${label}`;
  return `无法判断：${label}`;
}

function normalizeChecklistLabel(value: string): string {
  return value
    .replace(/是否已经/g, '')
    .replace(/是否/g, '')
    .replace(/有没有/g, '')
    .replace(/\?|\？/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function typeSpecificKeyLabel(key: string, skillType?: LlmEnhancedSkillType): string | undefined {
  const labels: Record<string, string> = {
    route_selected_correctly: '路由选择正确',
    user_goal_preserved: '传给下游的用户目标完整',
    downstream_linked: '下游执行链路已关联',
    downstream_completed: '下游执行已闭环',
    user_facing_closed: '已向用户回传结果',
    asyncPromiseClosed: '异步承诺已关闭',
    delegation_contract_followed: '遵守委派契约',
    child_lifecycle_tracked: '完整追踪 child session',
    parent_boundary_kept: '父会话没有越界接手',
    child_output_goal_match: 'child 产物匹配原目标',
    artifact_produced: '产物已生成',
    final_delivery_clear: '最终回复清楚',
    question_answered: '问题已回答',
    conclusion_actionable: '结论可直接使用',
    workflow_executed: '流程已执行',
    core_tools_used: '核心工具已使用',
    evidence_provided: '证据可回溯',
    uncertainty_stated: '不确定性已说明',
    workflow_stage_matrix_declared: '阶段矩阵已声明',
    stage_owner_mapped: '阶段责任已映射',
    stage_artifacts_tracked: '阶段产物已跟踪',
    stage_feedback_handled: '阶段反馈已处理',
    workflow_closure_reported: '流程闭环已汇总',
  };
  const label = labels[key];
  if (!label) return undefined;
  if (skillType === 'delegation' && key === 'delegation_contract_followed') return '编排者没有接手执行';
  if (skillType === 'workflow_owner' && key === 'workflow_stage_matrix_declared') return '标准阶段矩阵已声明';
  return label;
}

function failedTypeSpecificLabel(key: string, label: string): string {
  const failedLabels: Record<string, string> = {
    delegation_contract_followed: '未遵守委派契约：编排者接手了执行',
    child_lifecycle_tracked: '未完整追踪 child session',
    parent_boundary_kept: '父会话疑似越界接手',
    downstream_linked: '没有关联到下游执行链路',
    downstream_completed: '下游执行没有闭环',
    user_facing_closed: '没有向用户回传结果',
    asyncPromiseClosed: '异步承诺没有关闭',
    route_selected_correctly: '路由选择不正确',
    user_goal_preserved: '传给下游的用户目标不完整',
    child_output_goal_match: 'child 产物没有对齐原目标',
    workflow_stage_matrix_declared: '未声明标准阶段矩阵',
    stage_owner_mapped: '阶段责任没有映射到 owner / executor',
    stage_artifacts_tracked: '阶段产物没有被跟踪',
    stage_feedback_handled: '阶段反馈没有闭环处理',
    workflow_closure_reported: '没有汇总流程闭环状态',
  };
  return failedLabels[key] ?? `未通过：${label}`;
}

function typeSpecificAnswerKey(key: string): ExperienceSessionStoryAnswerKey {
  if ([
    'route_selected_correctly',
    'user_goal_preserved',
    'downstream_completed',
    'user_facing_closed',
    'asyncPromiseClosed',
    'async_promise_closed',
    'child_output_goal_match',
    'artifact_produced',
    'final_delivery_clear',
    'question_answered',
    'conclusion_actionable',
    'stage_artifacts_tracked',
    'stage_feedback_handled',
    'workflow_closure_reported',
  ].includes(key)) return 'goal_satisfaction';
  if ([
    'downstream_linked',
    'delegation_contract_followed',
    'child_lifecycle_tracked',
    'parent_boundary_kept',
    'workflow_executed',
    'core_tools_used',
    'evidence_provided',
    'uncertainty_stated',
    'workflow_stage_matrix_declared',
    'stage_owner_mapped',
  ].includes(key)) return 'declared_behavior_fit';
  return 'user_feeling';
}

function typeSpecificContribution(key: string, status: LlmEnhancedChecklistStatus): ExperienceChecklistContribution {
  if (status === 'not_applicable') return 'neutral';
  if ([
    'user_goal_preserved',
    'downstream_completed',
    'delegation_contract_followed',
    'parent_boundary_kept',
    'workflow_executed',
    'workflow_stage_matrix_declared',
    'stage_owner_mapped',
    'workflow_closure_reported',
    'artifact_produced',
    'question_answered',
  ].includes(key)) return 'blocking';
  if (status === 'passed') return 'positive';
  return 'attention';
}

function checklistStatus(status: LlmEnhancedChecklistStatus): ExperienceChecklistItemStatus {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'degraded') return 'degraded';
  if (status === 'not_applicable') return 'not_applicable';
  return 'unknown';
}

function worstAnswerStatus(
  base: ExperienceSessionStoryAnswer['status'],
  items: ExperienceChecklistItem[],
): ExperienceSessionStoryAnswer['status'] {
  if (items.some((item) => item.status === 'degraded')) return 'degraded';
  if (items.some((item) => item.status === 'failed')) return 'attention';
  if (base === 'attention' || base === 'degraded') return base;
  if (items.some((item) => item.status === 'unknown' || item.status === 'not_declared')) return 'unknown';
  return base;
}

function skillTypeLabel(value?: LlmEnhancedSkillType): string {
  if (value === 'router') return '路由型';
  if (value === 'delegation') return '委派型';
  if (value === 'executor') return '执行型';
  if (value === 'advisory') return '咨询型';
  if (value === 'workflow_owner') return '流程负责型';
  return '类型待确认';
}

function verdictStatus(value?: string): ExperienceSessionStoryAnswer['status'] {
  if (value === 'passed') return 'ok';
  if (value === 'failed') return 'attention';
  return 'unknown';
}

function feelingStatus(value?: string): ExperienceSessionStoryAnswer['status'] {
  if (value === 'positive') return 'ok';
  if (value === 'negative' || value === 'frustrated') return 'attention';
  return 'unknown';
}

function verdictItemStatus(value?: string): ExperienceChecklistItemStatus {
  if (value === 'passed') return 'passed';
  if (value === 'failed') return 'failed';
  return 'unknown';
}

function negativeSignalChecklistItem(
  key: string,
  label: string,
  value: string | undefined,
  reason: string,
  contribution: ExperienceChecklistContribution,
): ExperienceChecklistItem {
  return checklistItem(
    key,
    `${label}：${verdictLabel(value)}`,
    negativeSignalStatus(value),
    reason,
    contribution,
  );
}

function negativeSignalStatus(value?: string): ExperienceChecklistItemStatus {
  if (value === 'passed') return 'failed';
  if (value === 'failed') return 'passed';
  return 'unknown';
}

function feelingSignalVerdict(value?: string): 'passed' | 'failed' | 'unknown' {
  if (value === 'negative' || value === 'frustrated') return 'passed';
  if (value === 'positive' || value === 'neutral') return 'failed';
  return 'unknown';
}

function verdictLabel(value?: string): string {
  if (value === 'passed') return '是';
  if (value === 'failed') return '否';
  return '无法判断';
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function feelingLabel(value?: string): string {
  if (value === 'positive') return '正向';
  if (value === 'neutral') return '中性';
  if (value === 'negative') return '负向';
  if (value === 'frustrated') return '烦躁/失望';
  return '无法判断';
}

function reasonForStatus(status: ExperienceSessionStoryAnswer['status']): ExperienceSessionStoryAnswer['reason'] {
  if (status === 'ok') return 'all_passed';
  if (status === 'attention') return 'attention_accumulated';
  return 'unknown_dominant';
}

function checklistItem(
  key: string,
  label: string,
  status: ExperienceChecklistItemStatus,
  reason: string,
  contribution: ExperienceChecklistContribution = 'informational',
  suggestionKey?: string,
): ExperienceChecklistItem {
  return {
    key,
    label,
    status,
    contribution,
    reason,
    evidenceRefs: [],
    source: 'llm_soft',
    ...(suggestionKey ? { suggestionKey } : {}),
  };
}

function manualAnswerTouched(
  reviewState: ObservationReviewState,
  sessionId: string,
  skillName: string,
  answerKey: ExperienceSessionStoryAnswerKey,
): boolean {
  if (answerKey === 'goal_satisfaction') {
    return hasManualValue(reviewState, 'goal_keyword_correction', `${sessionId}:goal_keyword`)
      || hasManualValue(reviewState, 'completion_result_correction', `${sessionId}:completion_result`)
      || hasManualValue(reviewState, 'deliverable_artifact_correction', `${sessionId}:deliverable_artifact`);
  }
  if (answerKey === 'declared_behavior_fit') {
    return hasManualValue(reviewState, 'skill_relevance_correction', `${sessionId}:skill_relevance:${skillName}`)
      || hasManualValue(reviewState, 'workflow_completion_correction', `${sessionId}:workflow_completion:${skillName}`)
      || hasManualValue(reviewState, 'hardrule_execution_correction', `${sessionId}:hardrule_execution:${skillName}`)
      || hasManualValue(reviewState, 'main_tool_execution_correction', `${sessionId}:main_tool_execution:${skillName}`);
  }
  return false;
}

function hasManualValue(reviewState: ObservationReviewState, targetType: ObservationReviewTargetType, targetId: string): boolean {
  const entry = reviewState.entries[observationReviewStateKey(targetType, targetId)];
  if (!entry) return false;
  return Boolean(entry.note?.trim() || entry.reason?.trim() || entry.verdict);
}

function ownerSuggestionTexts(enhancedReview?: SkillLlmEnhancedReviewSections, skillType?: LlmEnhancedSkillType): ResolvedOwnerSuggestion[] {
  const checklistLabelByKey = new Map((enhancedReview?.typeSpecificAssessment?.checklist ?? [])
    .map((item) => [item.key, `${skillTypeLabel(skillType ?? enhancedReview?.skillType)}：${readableTypeSpecificLabel(item, skillType ?? enhancedReview?.skillType)}`] as const));
  for (const node of enhancedReview?.runtimeNodeResults?.nodes ?? []) {
    checklistLabelByKey.set(node.nodeId, `${runtimeNodeKindLabel(node.nodeKind)}：${node.title || node.nodeId}`);
  }
  for (const node of enhancedReview?.runtimeNodeAssessment?.nodes ?? []) {
    checklistLabelByKey.set(node.suggestionKey ?? node.nodeId, `${node.nodeKind === 'workflowNode' ? '流程节点' : '硬性规则'}：${node.nodeId}`);
  }
  return (enhancedReview?.ownerSuggestions ?? [])
    .flatMap((suggestion): ResolvedOwnerSuggestion[] => {
      const title = suggestion.title?.trim();
      const body = suggestion.body?.trim();
      const acceptance = suggestion.acceptanceCriteria?.trim();
      if (!title && !body && !acceptance) return [];
      return [{
        title: title || body || '优化 skill 行为',
        body: body && body !== title ? body : undefined,
        acceptanceCriteria: acceptance,
        checklistItemKey: suggestion.checklistItemKey,
        checklistItemLabel: suggestion.checklistItemKey ? checklistLabelByKey.get(suggestion.checklistItemKey) : undefined,
      }];
    })
    .filter((suggestion, index, arr) => {
      const key = [suggestion.title, suggestion.body, suggestion.acceptanceCriteria].filter(Boolean).join('\u0000');
      return arr.findIndex((candidate) => [candidate.title, candidate.body, candidate.acceptanceCriteria].filter(Boolean).join('\u0000') === key) === index;
    })
    .slice(0, 4);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function shortList(values?: string[]): string {
  return Array.from(new Set((values ?? [])
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)))
    .slice(0, 4)
    .join(' / ');
}
