import type {
  ExperienceChecklistContribution,
  ExperienceChecklistItem,
  ExperienceChecklistItemStatus,
  ExperienceReviewPriority,
  ExperienceSessionStoryAnswer,
  ExperienceSessionStoryAnswerKey,
} from './experience.js';
import type { ObservationReviewState, ObservationReviewTargetType } from './review-state.js';
import { observationReviewStateKey } from './review-state.js';
import type { LlmEnhancedChecklistStatus, LlmEnhancedSkillType, SkillLlmEnhancedReviewSections, SkillLlmTypeSpecificChecklistItem } from './soft-standards.js';

export interface ResolveObservationReviewSessionOptions {
  session: {
    id: string;
    skillName: string;
    reviewPriority: ExperienceReviewPriority;
    sessionStory?: {
      answers?: ExperienceSessionStoryAnswer[];
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
  const source: ResolvedObservationReviewSession['source'] = hasSessionManualReview
    ? 'manual'
    : hasLlmEnhancedReview
      ? 'llm'
      : 'deterministic';
  return {
    priority: resolvePriority(session.reviewPriority, enhancedReview, hasSessionManualReview),
    answers: resolveAnswers({
      sessionId: session.id,
      skillName: session.skillName,
      deterministicAnswers,
      enhancedReview,
      reviewState,
    }),
    reviewerSummary: enhancedReview?.reviewerSummary,
    ownerSuggestions: ownerSuggestionTexts(enhancedReview),
    skillType: enhancedReview?.skillType,
    typeSpecificChecklist: typeSpecificChecklistItems(enhancedReview),
    typeSpecificSummary: enhancedReview?.typeSpecificAssessment?.summary,
    source,
  };
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
): ExperienceReviewPriority {
  if (hasManualReview) return priority;
  const assessment = enhancedReview?.runtimeAssessment;
  const typeChecklist = enhancedReview?.typeSpecificAssessment?.checklist ?? [];
  if (!assessment && typeChecklist.length === 0) return priority;
  if (typeChecklist.some((item) => item.status === 'failed' || item.status === 'degraded')) return 'review_first';
  const hasFailed = assessment && (assessment.goalSatisfaction === 'failed'
    || assessment.declaredBehaviorFit === 'failed'
    || assessment.artifactGoalMatch === 'failed'
    || assessment.userFeeling === 'negative'
    || assessment.userFeeling === 'frustrated');
  if (hasFailed) return 'review_first';
  const hasUnknown = (assessment && (assessment.goalSatisfaction === 'unknown'
    || assessment.declaredBehaviorFit === 'unknown'
    || assessment.artifactGoalMatch === 'unknown'
    || assessment.userFeeling === 'neutral'))
    || typeChecklist.some((item) => item.status === 'unknown');
  if (hasUnknown && priority === 'routine_sample') return 'sample_review';
  return priority;
}

function resolveAnswers(options: {
  sessionId: string;
  skillName: string;
  deterministicAnswers: ExperienceSessionStoryAnswer[];
  enhancedReview?: SkillLlmEnhancedReviewSections;
  reviewState: ObservationReviewState;
}): ExperienceSessionStoryAnswer[] {
  const { deterministicAnswers, enhancedReview } = options;
  if (!enhancedReview?.runtimeAssessment && !enhancedReview?.typeSpecificAssessment?.checklist?.length) return deterministicAnswers;
  const baseAnswers = deterministicAnswers.length > 0 ? deterministicAnswers : defaultAnswers();
  return baseAnswers.map((answer) =>
    manualAnswerTouched(options.reviewState, options.sessionId, options.skillName, answer.key)
      ? answer
      : resolveAnswerFromLlm(answer, enhancedReview)
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
): ExperienceSessionStoryAnswer {
  const assessment = enhancedReview.runtimeAssessment;
  if (!assessment) return answer;
  if (answer.key === 'goal_satisfaction') {
    const status = verdictStatus(assessment.goalSatisfaction);
    const artifactStatus = verdictStatus(assessment.artifactGoalMatch);
    const goalText = shortList(enhancedReview.userGoal?.slots) || enhancedReview.userGoal?.summary || '未提取到';
    const typeItems = typeSpecificChecklistForAnswer(enhancedReview, 'goal_satisfaction');
    return {
      ...answer,
      status: worstAnswerStatus(status, typeItems),
      reason: reasonForStatus(worstAnswerStatus(status, typeItems)),
      text: enhancedReview.reviewerSummary ?? answer.text,
      checklistItems: [
        checklistItem('llm_user_goal_slots', `用户目标关键词：${goalText}`, goalText !== '未提取到' ? 'passed' : 'unknown', 'LLM 基于运行时用户消息抽取目标关键词。'),
        checklistItem('llm_goal_satisfaction', `用户目标满足：${verdictLabel(assessment.goalSatisfaction)}`, status === 'ok' ? 'passed' : status === 'attention' ? 'failed' : 'unknown', 'LLM 基于运行证据判断目标是否满足。', 'blocking'),
        checklistItem('llm_artifact_goal_match', `产物对题：${verdictLabel(assessment.artifactGoalMatch)}`, artifactStatus === 'ok' ? 'passed' : artifactStatus === 'attention' ? 'failed' : 'unknown', 'LLM 判断产物是否匹配用户目标。', 'attention'),
        ...typeItems,
      ],
    };
  }
  if (answer.key === 'declared_behavior_fit') {
    const status = verdictStatus(assessment.declaredBehaviorFit);
    const declaredGoal = shortList([
      ...(enhancedReview.skillDeclaredGoal?.keywords ?? []),
      ...(enhancedReview.skillDeclaredGoal?.expectedOutcomes ?? []),
    ]) || enhancedReview.skillDeclaredGoal?.summary || '未提取到';
    const typeItems = typeSpecificChecklistForAnswer(enhancedReview, 'declared_behavior_fit');
    return {
      ...answer,
      status: worstAnswerStatus(status, typeItems),
      reason: reasonForStatus(worstAnswerStatus(status, typeItems)),
      text: enhancedReview.reviewerSummary ?? answer.text,
      checklistItems: [
        checklistItem('llm_skill_declared_goal', `skill 声明目标：${declaredGoal}`, declaredGoal !== '未提取到' ? 'passed' : 'unknown', 'LLM 基于 SKILL.md 抽取能力声明目标。'),
        checklistItem('llm_declared_behavior_fit', `行为符合声明：${verdictLabel(assessment.declaredBehaviorFit)}`, status === 'ok' ? 'passed' : status === 'attention' ? 'failed' : 'unknown', 'LLM 判断运行行为是否符合 skill 声明。', 'blocking'),
        ...typeItems,
      ],
    };
  }
  if (answer.key === 'user_feeling') {
    const status = feelingStatus(assessment.userFeeling);
    const signals = enhancedReview.userExperienceSignals;
    const typeItems = typeSpecificChecklistForAnswer(enhancedReview, 'user_feeling');
    return {
      ...answer,
      status: worstAnswerStatus(status, typeItems),
      reason: reasonForStatus(worstAnswerStatus(status, typeItems)),
      text: enhancedReview.reviewerSummary ?? answer.text,
      checklistItems: [
        checklistItem('llm_user_useful', `用户觉得有用：${verdictLabel(signals?.useful)}`, verdictItemStatus(signals?.useful), 'LLM 判断用户是否表现出有用或采纳信号。', 'positive'),
        checklistItem('llm_user_follow_up', `用户追问：${verdictLabel(signals?.followUp)}`, verdictItemStatus(signals?.followUp), 'LLM 判断用户是否继续追问结果、进度或补充上下文。', 'attention'),
        checklistItem('llm_user_correction', `用户纠正：${verdictLabel(signals?.correction)}`, verdictItemStatus(signals?.correction), 'LLM 判断用户是否明确纠正方向或结果。', 'attention'),
        checklistItem('llm_user_negative_feedback', `负向反馈：${verdictLabel(signals?.negativeFeedback)}`, verdictItemStatus(signals?.negativeFeedback), 'LLM 判断用户是否表达不满、否定或失望。', 'attention'),
        checklistItem('llm_user_interruption', `中断流程：${verdictLabel(signals?.interruption)}`, verdictItemStatus(signals?.interruption), 'LLM 判断用户是否中断、停止或放弃当前流程。', 'blocking'),
        checklistItem('llm_user_frustration', `烦躁/失望：${signals?.frustration ? verdictLabel(signals.frustration) : feelingLabel(assessment.userFeeling)}`, signals?.frustration ? verdictItemStatus(signals.frustration) : status === 'attention' ? 'failed' : status === 'ok' ? 'passed' : 'unknown', 'LLM 基于用户反馈、追问和语气判断用户是否烦躁或失望。', 'attention'),
        ...typeItems,
      ],
    };
  }
  return answer;
}

function typeSpecificChecklistForAnswer(
  enhancedReview: SkillLlmEnhancedReviewSections,
  answerKey: ExperienceSessionStoryAnswerKey,
): ExperienceChecklistItem[] {
  return (enhancedReview.typeSpecificAssessment?.checklist ?? [])
    .filter((item) => typeSpecificAnswerKey(item.key) === answerKey)
    .map((item) => typeSpecificChecklistItem(item, enhancedReview.skillType));
}

function typeSpecificChecklistItems(enhancedReview?: SkillLlmEnhancedReviewSections): ExperienceChecklistItem[] {
  const items = enhancedReview?.typeSpecificAssessment?.checklist ?? [];
  return items.map((item) => typeSpecificChecklistItem(item, enhancedReview?.skillType));
}

function typeSpecificChecklistItem(item: SkillLlmTypeSpecificChecklistItem, skillType?: LlmEnhancedSkillType): ExperienceChecklistItem {
  return checklistItem(
    `llm_type_${item.key}`,
    `${skillTypeLabel(skillType)}：${item.label}`,
    checklistStatus(item.status),
    item.reason || 'LLM 按 skill 类型判断该项运行表现。',
    typeSpecificContribution(item.key, item.status),
    item.suggestionKey,
  );
}

function typeSpecificAnswerKey(key: string): ExperienceSessionStoryAnswerKey {
  if ([
    'route_selected_correctly',
    'user_goal_preserved',
    'downstream_completed',
    'user_facing_closed',
    'child_output_goal_match',
    'artifact_produced',
    'final_delivery_clear',
    'question_answered',
    'conclusion_actionable',
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

function verdictLabel(value?: string): string {
  if (value === 'passed') return '是';
  if (value === 'failed') return '否';
  return '无法判断';
}

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

function ownerSuggestionTexts(enhancedReview?: SkillLlmEnhancedReviewSections): ResolvedOwnerSuggestion[] {
  const checklistLabelByKey = new Map((enhancedReview?.typeSpecificAssessment?.checklist ?? [])
    .map((item) => [item.key, `${skillTypeLabel(enhancedReview?.skillType)}：${item.label}`] as const));
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

function shortList(values?: string[]): string {
  return Array.from(new Set((values ?? [])
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)))
    .slice(0, 4)
    .join(' / ');
}
