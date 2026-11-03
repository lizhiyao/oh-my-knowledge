import type {
  ExperienceChecklistItem,
  ExperienceChecklistItemStatus,
  ExperienceEpisode,
  ExperienceEvidenceRef,
  ExperienceFeedbackSignal,
  ExperienceParentReason,
  ExperienceReviewIndicators,
  ExperienceReviewerReportFindingSource,
  ExperienceReviewerReportStepStatus,
  ExperienceSessionStoryAnswerKey,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from '../contracts/experience.js';
import type {
  ObservationMetricKey,
  ObservationReviewState,
} from '../contracts/review.js';
import {
  observationMetricAnnotationVerdict,
} from '../inbox/review-state.js';
import {
  isAssistantProgressUpdateText,
} from './text-signals.js';
import {
  unique,
} from './primitives.js';
import {
  currentSkillRuntimeModel,
  uniqueEvidenceRefs,
  userFacingClosureForSession,
  type CurrentSkillRuntimeModel,
} from './report-derivations.js';
import {
  loadExpectedToolsForSkill,
  loadSkillDeclarationCheck,
} from '../skill-health/experience-frontmatter.js';

export function aggregateExperienceChecklistItemStatus(statuses: ExperienceChecklistItemStatus[]): ExperienceChecklistItemStatus {
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('not_declared')) return 'not_declared';
  if (statuses.includes('passed')) return 'passed';
  return 'not_applicable';
}

export function checklistItemsForAnswer(
  session: ExperienceSessionSummary,
  key: ExperienceSessionStoryAnswerKey,
  episodes?: ExperienceEpisode[],
  reviewState?: ObservationReviewState,
): ExperienceChecklistItem[] {
  if (key === 'goal_satisfaction') return goalSatisfactionChecklistItems(session, episodes, reviewState);
  if (key === 'declared_behavior_fit') return declaredBehaviorChecklistItems(session, episodes);
  return userFeelingChecklistItems(session, episodes, reviewState);
}

export function attributionSourcesToLabel(sources: string[]): string {
  if (sources.length === 0) return '未识别（旧数据可能没记录来源）';
  const map: Record<string, string> = {
    'skill-tool': 'assistant 调用 Skill 工具',
    'command-name': '用户用 slash command',
    'business-action': '用户用业务动作块',
    [legacyBusinessActionSource()]: '用户用业务动作块',
    'skill-script': '跑了 skills/<name>/scripts 脚本',
    'read-skill-md': 'LLM 主动 Read SKILL.md',
    unknown: '未知',
  };
  return sources.map((s) => map[s] ?? s).join(' + ');
}

export function isExperienceTraceInProgress(session: ExperienceSessionSummary): boolean {
  if (session.indicators.assistantDeliverySignalCount > 0) return false;
  if (session.indicators.deliverableArtifactSignalCount > 0) return false;
  // 用户已经主动表达不满（纠正 / 负向 / 中断）属于「被打断」, 不是「在途中」, 仍需触发 final_delivery_absent。
  if (session.indicators.userCorrectionCount > 0) return false;
  if (session.indicators.negativeFeedbackCount > 0) return false;
  if (session.indicators.userInterruptionCount > 0) return false;
  const last = session.evidenceChain.lastAssistantMessage?.snippet ?? '';
  // 完全没有最后助手回复时不强判 in-progress, 走原 failed / unknown 路径。
  if (!last.trim()) return false;
  if (isAssistantProgressUpdateText(last)) return true;
  // 预备语（让我看 / 先看看 / 先读 / 接下来）也算 in-progress, 仍未给出最终回复。
  return /让我(?:先|来|看|读|检查|分析|确认|拉|获取|继续)|先(?:看(?:看|一?下)|读(?:取|一下)?|确认|检查|分析|拉取|获取)|接下来/i.test(last);
}

export function checklistItem(input: Omit<ExperienceChecklistItem, 'source' | 'evidenceRefs'> & {
  evidenceRefs?: Array<ExperienceEvidenceRef | undefined>;
  source?: ExperienceReviewerReportFindingSource;
  statusCandidates?: ExperienceChecklistItemStatus[];
}): ExperienceChecklistItem {
  const { statusCandidates, ...item } = input;
  return {
    ...item,
    status: aggregateExperienceChecklistItemStatus([input.status, ...(statusCandidates ?? [])]),
    source: input.source ?? 'deterministic_rule',
    evidenceRefs: uniqueEvidenceRefs((input.evidenceRefs ?? []).filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))).slice(0, 5),
  };
}

export function hasRecognizableUserGoalText(value: string | undefined): boolean {
  const text = value?.trim() ?? '';
  if (!text) return false;
  if (/^(嗯+|啊+|好的|好|继续|可以|收到|ok|OK|yes|no|不用|不需要)[。.!！?？\s]*$/.test(text)) return false;
  if (/(帮我|请|需要|想要|我要|给我|看下|看一下|基于|根据|重新|继续|先|把|将)/.test(text)
    && /(生成|创建|写|实现|修复|优化|调整|修改|新增|删除|分析|review|评价|检查|看|拉取|执行|运行|验证|整理|总结|回复|评论|设计|拆分|合并|标注|定位|排查|上传|导出|发布|查询|对齐|沉淀|补充|改|做)/i.test(text)) {
    return true;
  }
  if (/(生成|创建|写一个|实现|修复|优化|调整|修改|新增|分析|review|检查|排查|验证|总结|设计|标注|定位|查询|对齐|补充|改一下|做一个)/i.test(text)) return true;
  return text.length >= 12 && /[？?]/.test(text) && !/^(为什么|怎么|哪里)[？?]?$/.test(text);
}

export function hasRecognizableUserGoal(ref?: ExperienceEvidenceRef): boolean {
  return hasRecognizableUserGoalText(ref?.snippet);
}

export function goalSatisfactionChecklistItems(session: ExperienceSessionSummary, episodes?: ExperienceEpisode[], reviewState?: ObservationReviewState): ExperienceChecklistItem[] {
  const feedbackRefs = userFeedbackEvidenceRefs(session);
  const feedbackCounts = canonicalFeedbackCountsForSession(session, reviewState);
  const goalIdentified = hasRecognizableUserGoal(session.evidenceChain.firstUserMessage);
  const inProgress = isExperienceTraceInProgress(session);
  const closure = userFacingClosureForSession(session, episodes);
  const hasDelivery = closure.deliveryCount > 0;
  const hasArtifact = closure.artifactCount > 0;
  return [
    checklistItem({
      key: 'goal_identified',
      label: goalIdentified ? '目标已识别' : '目标不明确',
      status: goalIdentified ? 'passed' : 'unknown',
      contribution: 'informational',
      reason: goalIdentified
        ? '真实用户原文里能识别出目标动作或明确请求。'
        : session.evidenceChain.firstUserMessage ? '看到真实用户原文，但目标动作不够明确。' : '没有看到真实用户目标原文。',
      evidenceRefs: [session.evidenceChain.firstUserMessage],
    }),
    checklistItem({
      key: 'completion_result_present',
      label: hasDelivery ? '给了用户最终答复' : inProgress ? '会话进行中' : '没给用户最终答复',
      status: hasDelivery ? 'passed' : inProgress ? 'not_applicable' : 'failed',
      contribution: hasDelivery ? 'attention' : inProgress ? 'neutral' : 'attention',
      reason: hasDelivery
        ? '看到 assistant 给出了明确的完成话术或结果反馈。'
        : inProgress
          ? '最后一句还是过程态（「先看看」「让我」），任务还没收尾，先不判定。'
          : '没看到 assistant 给用户明确的完成话术或结果反馈。'
,
      evidenceRefs: [session.evidenceChain.lastAssistantMessage],
      suggestionKey: hasDelivery || inProgress ? undefined : 'final_delivery_absent',
    }),
    checklistItem({
      key: 'deliverable_artifact_present',
      label: hasArtifact ? '给了可点开的产物' : inProgress ? '会话进行中' : '没给可点开的产物',
      status: hasArtifact ? 'passed' : inProgress ? 'not_applicable' : 'unknown',
      contribution: hasArtifact ? 'informational' : inProgress ? 'neutral' : 'informational',
      reason: hasArtifact
        ? '看到 assistant 回复里附了链接、路径、代码块或文件。'
        : inProgress
          ? '任务还没收尾，先不判定产物。'
          : '没看到明确的链接、路径、代码块或文件；不一定失败，得按 skill 目标判断。',
      evidenceRefs: [session.evidenceChain.lastAssistantMessage],
      suggestionKey: hasArtifact || inProgress ? undefined : 'artifact_absent',
    }),
    checklistItem({
      key: 'negative_feedback_seen',
      label: feedbackCounts.negativeFeedbackCount > 0 ? '看到用户负向反馈' : '未见用户负向反馈',
      status: feedbackCounts.negativeFeedbackCount > 0 ? 'failed' : 'passed',
      contribution: 'blocking',
      reason: feedbackCounts.negativeFeedbackCount > 0 ? '看到用户负向表达，不能直接认为目标已满足。' : '没有看到用户负向表达。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.negativeFeedbackCount > 0 ? 'negative_feedback_review' : undefined,
    }),
    checklistItem({
      key: 'user_correction_seen',
      label: feedbackCounts.userCorrectionCount > 0 ? '看到用户纠正' : '未见用户纠正',
      status: feedbackCounts.userCorrectionCount > 0 ? 'failed' : 'passed',
      contribution: 'attention',
      reason: feedbackCounts.userCorrectionCount > 0 ? '用户中途纠正了方向，目标是否满足要打开原文看。' : '没有看到用户纠正。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.userCorrectionCount > 0 ? 'user_correction_review' : undefined,
    }),
    checklistItem({
      key: 'user_interruption_seen',
      label: feedbackCounts.userInterruptionCount > 0 ? '看到用户中断' : '未见用户中断',
      status: feedbackCounts.userInterruptionCount > 0 ? 'failed' : 'passed',
      contribution: 'blocking',
      reason: feedbackCounts.userInterruptionCount > 0 ? '看到用户中断或停止任务信号，不能认为执行链路自然完成。' : '没有看到用户中断信号。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.userInterruptionCount > 0 ? 'user_interruption_review' : undefined,
    }),
    checklistItem({
      key: 'goal_shift_seen',
      label: session.indicators.userGoalShiftCount > 0 ? '看到目标切换' : '未见目标切换',
      status: session.indicators.userGoalShiftCount > 0 ? 'failed' : 'passed',
      contribution: 'attention',
      reason: session.indicators.userGoalShiftCount > 0 ? '用户中途切换了目标，后续诉求可能不属于这个 skill。' : '没有看到目标切换。',
      evidenceRefs: feedbackRefs,
      suggestionKey: session.indicators.userGoalShiftCount > 0 ? 'goal_shift_review' : undefined,
    }),
    ...skillTypeClosureChecklistItems(session, 'goal_satisfaction', episodes),
  ];
}

export function declaredBehaviorChecklistItems(session: ExperienceSessionSummary, episodes?: ExperienceEpisode[]): ExperienceChecklistItem[] {
  const expectedToolCheck = expectedToolCheckForSession(session);
  const declarations = loadSkillDeclarationCheck(session.skillName, session.cwd);
  const hasSkillRead = session.evidenceChain.skillContextCount > 0;
  const attributionLabel = attributionSourcesToLabel(session.attributionSources ?? []);
  const items: ExperienceChecklistItem[] = [
    checklistItem({
      key: 'attribution_source',
      label: hasSkillRead
        ? 'LLM 读了 SKILL.md'
        : `skill 判定来源：${attributionLabel}`,
      status: 'passed',
      contribution: 'informational',
      reason: hasSkillRead
        ? `看到 ${session.evidenceChain.skillContextCount} 次 SKILL.md 加载事件，可作为能力归因证据。`
        : `日志里没看到 LLM 主动读取 SKILL.md。这次 skill 归因来自：${attributionLabel}。脚本、Skill 工具或命令触发时可能没有显式读取事件，不代表 skill 没用上。`,
      evidenceRefs: [session.evidenceChain.firstSkillContext, session.evidenceChain.firstToolUse],
    }),
    checklistItem({
      key: 'workflow_declared',
      label: declarations.workflows.declared ? '标准流程已声明' : '标准流程未声明',
      status: declarations.workflows.declared ? 'passed' : 'not_declared',
      contribution: declarations.workflows.declared ? 'informational' : 'attention',
      reason: declarations.workflows.declared ? `SKILL.md 里声明了 ${declarations.workflows.count} 个标准流程节点。` : 'SKILL.md 没声明标准流程，运行时只能猜流程是否完整。',
      suggestionKey: declarations.workflows.declared ? undefined : 'workflow_not_declared',
    }),
  ];
  if (declarations.workflows.declared) {
    const executed = session.indicators.toolCallCount > 0;
    items.push(checklistItem({
      key: 'workflow_executed',
      label: executed ? '标准流程已执行' : '标准流程未执行',
      status: executed ? 'unknown' : 'failed',
      contribution: 'attention',
      reason: executed ? '看到了工具调用，但是不是真的覆盖了完整流程，还要打开原文确认。' : '声明了标准流程，但没看到工具执行的证据。',
      evidenceRefs: [session.evidenceChain.firstToolUse],
      suggestionKey: 'workflow_execution_review',
    }));
  }
  items.push(checklistItem({
    key: 'hardrule_declared',
    label: declarations.hardRules.declared ? '硬性规则已声明' : '硬性规则未声明',
    status: declarations.hardRules.declared ? 'passed' : 'not_declared',
    contribution: declarations.hardRules.declared ? 'informational' : 'attention',
    reason: declarations.hardRules.declared ? `SKILL.md 里声明了 ${declarations.hardRules.count} 条硬性规则。` : 'SKILL.md 没声明硬性规则。',
    suggestionKey: declarations.hardRules.declared ? undefined : 'hardrule_not_declared',
  }));
  if (declarations.hardRules.declared) {
    items.push(checklistItem({
      key: 'hardrule_executed',
      label: '硬性规则执行情况需打开原文看',
      status: 'unknown',
      contribution: 'attention',
      reason: '声明了硬性规则，但当前规则没法完整证明每条都执行了，要打开原文看。',
      suggestionKey: 'hardrule_execution_review',
    }));
  }
  items.push(checklistItem({
    key: 'core_tools_declared',
    label: expectedToolCheck.declared ? '核心工具已声明' : '核心工具未声明',
    status: expectedToolCheck.declared ? 'passed' : 'not_declared',
    contribution: expectedToolCheck.declared ? 'informational' : 'attention',
    reason: expectedToolCheck.declared ? `SKILL.md 声明的核心工具：${expectedToolCheck.expectedTools.join('、')}。` : 'SKILL.md 没声明核心工具，分不出「真用上了 skill 工具」还是「只是随便调了个工具」。',
    suggestionKey: expectedToolCheck.declared ? undefined : 'expected_tools_not_declared',
  }));
  if (expectedToolCheck.declared) {
    const hit = expectedToolCheck.matchedTools.length > 0;
    items.push(checklistItem({
      key: 'core_tools_hit',
      label: hit ? '核心工具用上了' : '核心工具没用上',
      status: hit ? 'passed' : 'failed',
      contribution: 'blocking',
      reason: hit ? `用上了核心工具：${expectedToolCheck.matchedTools.join('、')}。` : '没用上 SKILL.md 声明的核心工具。',
      evidenceRefs: [session.evidenceChain.firstToolUse],
      suggestionKey: hit ? undefined : 'expected_tools_missed',
    }));
  }
  items.push(...skillTypeClosureChecklistItems(session, 'declared_behavior_fit', episodes));
  return items;
}

export function userFeelingChecklistItems(session: ExperienceSessionSummary, episodes?: ExperienceEpisode[], reviewState?: ObservationReviewState): ExperienceChecklistItem[] {
  const feedbackRefs = userFeedbackEvidenceRefs(session);
  const feedbackCounts = canonicalFeedbackCountsForSession(session, reviewState);
  const hasAnyFeedback = feedbackCounts.positiveFeedbackCount > 0
    || feedbackCounts.negativeFeedbackCount > 0
    || feedbackCounts.userCorrectionCount > 0
    || feedbackCounts.userInterruptionCount > 0
    || feedbackCounts.userFollowUpCount > 0
    || session.indicators.userGoalShiftCount > 0;
  return [
    checklistItem({
      key: 'user_feedback_signal_present',
      label: hasAnyFeedback ? '看到用户反馈信号' : '未见用户反馈信号',
      status: hasAnyFeedback ? 'passed' : 'unknown',
      contribution: 'informational',
      reason: hasAnyFeedback ? '看到至少一种用户反馈或后续行为信号。' : '没有看到明确用户反馈信号。',
      evidenceRefs: feedbackRefs,
    }),
    checklistItem({
      key: 'positive_feedback_seen',
      label: feedbackCounts.positiveFeedbackCount > 0 ? '看到用户正向反馈' : '未见用户正向反馈',
      status: feedbackCounts.positiveFeedbackCount > 0 ? 'passed' : 'unknown',
      contribution: feedbackCounts.positiveFeedbackCount > 0 ? 'positive' : 'neutral',
      reason: feedbackCounts.positiveFeedbackCount > 0 ? '看到用户认可或正向反馈。' : '没有看到明确正向反馈。',
      evidenceRefs: feedbackRefs,
    }),
    checklistItem({
      key: 'negative_feedback_seen',
      label: feedbackCounts.negativeFeedbackCount > 0 ? '看到用户负向反馈' : '未见用户负向反馈',
      status: feedbackCounts.negativeFeedbackCount > 0 ? 'failed' : 'passed',
      contribution: feedbackCounts.negativeFeedbackCount > 0 ? 'blocking' : 'neutral',
      reason: feedbackCounts.negativeFeedbackCount > 0 ? '看到用户负向表达。' : '没有看到用户负向表达。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.negativeFeedbackCount > 0 ? 'negative_feedback_review' : undefined,
    }),
    checklistItem({
      key: 'user_correction_seen',
      label: feedbackCounts.userCorrectionCount > 0 ? '看到用户纠正' : '未见用户纠正',
      status: feedbackCounts.userCorrectionCount > 0 ? 'failed' : 'passed',
      contribution: feedbackCounts.userCorrectionCount > 0 ? 'attention' : 'neutral',
      reason: feedbackCounts.userCorrectionCount > 0 ? '看到用户重新解释或要求修正。' : '没有看到用户纠正信号。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.userCorrectionCount > 0 ? 'user_correction_review' : undefined,
    }),
    checklistItem({
      key: 'user_follow_up_seen',
      label: feedbackCounts.userFollowUpCount > 0 ? '看到用户追问' : '未见用户追问',
      status: feedbackCounts.userFollowUpCount > 0 ? 'unknown' : 'passed',
      contribution: feedbackCounts.userFollowUpCount > 0 ? 'informational' : 'neutral',
      reason: feedbackCounts.userFollowUpCount > 0 ? '看到用户追问；需要结合上下文区分推进使用还是不满意。' : '没有看到用户追问。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.userFollowUpCount > 0 ? 'follow_up_review' : undefined,
    }),
    checklistItem({
      key: 'user_interruption_seen',
      label: feedbackCounts.userInterruptionCount > 0 ? '看到用户中断' : '未见用户中断',
      status: feedbackCounts.userInterruptionCount > 0 ? 'failed' : 'passed',
      contribution: feedbackCounts.userInterruptionCount > 0 ? 'blocking' : 'neutral',
      reason: feedbackCounts.userInterruptionCount > 0 ? '看到用户中断或停止任务信号。' : '没有看到用户中断信号。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.userInterruptionCount > 0 ? 'user_interruption_review' : undefined,
    }),
    ...skillTypeClosureChecklistItems(session, 'user_feeling', episodes),
  ];
}

export function skillTypeClosureChecklistItems(
  session: ExperienceSessionSummary,
  answerKey: ExperienceSessionStoryAnswerKey,
  episodes?: ExperienceEpisode[],
): ExperienceChecklistItem[] {
  const runtime = currentSkillRuntimeModel(session, episodes);
  if (!runtime) return [];
  if (runtime.skillType === 'workflow_owner') return workflowOwnerClosureChecklistItems(session, runtime, answerKey, episodes);
  if (runtime.skillType === 'router' || runtime.hasDownstreamEdges) return routerClosureChecklistItems(session, runtime, answerKey, episodes);
  if (runtime.skillType === 'delegation' || runtime.isDelegator) return delegationClosureChecklistItems(session, runtime, answerKey, episodes);
  if (runtime.skillType === 'executor') return executorClosureChecklistItems(session, runtime, answerKey);
  if (runtime.skillType === 'advisory') return advisoryClosureChecklistItems(session, runtime, answerKey);
  return [];
}

export function workflowOwnerClosureChecklistItems(
  session: ExperienceSessionSummary,
  runtime: CurrentSkillRuntimeModel,
  answerKey: ExperienceSessionStoryAnswerKey,
  episodes?: ExperienceEpisode[],
): ExperienceChecklistItem[] {
  if (answerKey === 'declared_behavior_fit') {
    const hasStages = runtime.segments.some((segment) =>
      (segment.typeSpecificChecklist ?? []).some((item) => /stage|阶段|workflow/i.test(`${item.key} ${item.label}`))
    );
    return [
      checklistItem({
        key: 'workflow_owner_stage_matrix_declared',
        label: hasStages ? '看到阶段矩阵线索' : '未看到阶段矩阵声明',
        status: hasStages ? 'passed' : 'unknown',
        contribution: 'attention',
        reason: hasStages
          ? '当前 workflow_owner skill 有阶段化检查线索。'
          : 'workflow_owner 需要声明标准阶段矩阵，才能复盘每个阶段是否闭环。',
        evidenceRefs: runtime.segments.flatMap((segment) => segment.evidenceRefs),
        suggestionKey: hasStages ? undefined : 'workflow_owner_stage_matrix_absent',
      }),
    ];
  }
  if (answerKey === 'goal_satisfaction') {
    const closure = userFacingClosureForSession(session, episodes);
    const hasClosure = closure.deliveryCount > 0 || closure.artifactCount > 0;
    return [
      checklistItem({
        key: 'workflow_owner_stage_closure',
        label: hasClosure ? '看到流程闭环线索' : '未看到流程闭环线索',
        status: hasClosure ? 'passed' : runtime.primarySignals.length > 0 || runtime.downstreamSignals.length > 0 ? 'failed' : 'unknown',
        contribution: 'attention',
        reason: hasClosure
          ? '看到最终答复或产物线索。'
          : 'workflow_owner 需要回收各阶段状态，说明哪些阶段完成、失败或跳过。',
        evidenceRefs: [session.evidenceChain.lastAssistantMessage, ...runtime.primarySignals.map((signal) => signal.evidenceRef), ...runtime.downstreamSignals.map((signal) => signal.evidenceRef)],
        suggestionKey: hasClosure ? undefined : 'workflow_owner_stage_closure_absent',
      }),
    ];
  }
  if (answerKey === 'user_feeling') {
    return downstreamFeedbackRiskChecklistItems(runtime, 'workflow_owner_stage_feedback_seen', '流程阶段里出现用户追问或纠正');
  }
  return [];
}

export function routerClosureChecklistItems(
  session: ExperienceSessionSummary,
  runtime: CurrentSkillRuntimeModel,
  answerKey: ExperienceSessionStoryAnswerKey,
  episodes?: ExperienceEpisode[],
): ExperienceChecklistItem[] {
  if (answerKey === 'declared_behavior_fit') {
    return [
      checklistItem({
        key: 'router_route_selected',
        label: runtime.hasDownstreamEdges ? '路由已派发下游' : '未看到下游派发',
        status: runtime.hasDownstreamEdges ? 'passed' : 'unknown',
        contribution: 'attention',
        reason: runtime.hasDownstreamEdges
          ? '看到当前 skill 和下游执行 skill / child session 的链路。'
          : '没有看到当前 router skill 把任务派发到下游执行链路。',
        evidenceRefs: runtime.downstreamEdges.flatMap((edge) => edge.evidenceRefs),
        suggestionKey: runtime.hasDownstreamEdges ? undefined : 'router_downstream_link_absent',
      }),
      checklistItem({
        key: 'router_goal_preserved',
        label: '用户目标保真需复核',
        status: 'unknown',
        contribution: 'informational',
        reason: '规则层只能确认发生了派发，child prompt 是否完整保留用户目标需要结合原文或模型识别。',
        evidenceRefs: [session.evidenceChain.firstUserMessage, ...runtime.downstreamEdges.flatMap((edge) => edge.evidenceRefs)],
        suggestionKey: 'router_goal_preservation_review',
      }),
    ];
  }
  if (answerKey === 'goal_satisfaction') {
    const hasDownstreamRisk = runtime.downstreamSignals.length > 0;
    const closure = userFacingClosureForSession(session, episodes);
    const hasClosure = closure.deliveryCount > 0 || closure.artifactCount > 0;
    return [
      checklistItem({
        key: 'router_downstream_completed',
        label: hasClosure ? '看到用户侧闭环线索' : '未看到用户侧闭环线索',
        status: hasClosure ? 'passed' : hasDownstreamRisk ? 'failed' : 'unknown',
        contribution: 'attention',
        reason: hasClosure
          ? '看到当前链路里有最终答复或产物线索。'
          : hasDownstreamRisk
            ? '下游调用链路出现用户追问 / 纠正 / 中断，但当前路由能力视角没看到清晰闭环。'
            : '已看到派发，但还不能确认下游是否完成并回传。',
        evidenceRefs: [
          session.evidenceChain.lastAssistantMessage,
          ...runtime.downstreamSignals.map((signal) => signal.evidenceRef),
        ],
        suggestionKey: hasClosure ? undefined : 'router_user_facing_closure_absent',
      }),
    ];
  }
  if (answerKey === 'user_feeling') {
    return downstreamFeedbackRiskChecklistItems(runtime, 'router_downstream_feedback_seen', '下游调用链路用户有追问');
  }
  return [];
}

export function delegationClosureChecklistItems(
  session: ExperienceSessionSummary,
  runtime: CurrentSkillRuntimeModel,
  answerKey: ExperienceSessionStoryAnswerKey,
  episodes?: ExperienceEpisode[],
): ExperienceChecklistItem[] {
  if (answerKey === 'declared_behavior_fit') {
    const hasChild = runtime.hasDownstreamEdges || session.timelineTree?.branches.length;
    return [
      checklistItem({
        key: 'delegation_child_lifecycle_tracked',
        label: hasChild ? '看到 child / 下游生命周期' : '未看到 child 生命周期',
        status: hasChild ? 'passed' : 'unknown',
        contribution: 'attention',
        reason: hasChild ? '看到 child session、下游 skill 或分支执行线索。' : '没有看到明确 child session 或下游执行线索。',
        evidenceRefs: runtime.downstreamEdges.flatMap((edge) => edge.evidenceRefs),
        suggestionKey: hasChild ? undefined : 'delegation_child_lifecycle_absent',
      }),
    ];
  }
  if (answerKey === 'goal_satisfaction') {
    const closure = userFacingClosureForSession(session, episodes);
    const hasResult = closure.deliveryCount > 0 || closure.artifactCount > 0;
    return [
      checklistItem({
        key: 'delegation_result_recovered',
        label: hasResult ? '已回收结果给用户' : '未看到结果回收',
        status: hasResult ? 'passed' : runtime.primarySignals.length > 0 ? 'failed' : 'unknown',
        contribution: 'attention',
        reason: hasResult ? '看到最终答复或产物线索。' : 'delegation skill 需要把 child 结果回收并告知用户。',
        evidenceRefs: [session.evidenceChain.lastAssistantMessage, ...runtime.primarySignals.map((signal) => signal.evidenceRef)],
        suggestionKey: hasResult ? undefined : 'delegation_result_recovery_absent',
      }),
    ];
  }
  if (answerKey === 'user_feeling') {
    return downstreamFeedbackRiskChecklistItems(runtime, 'delegation_downstream_feedback_seen', 'child 调用链路用户有反馈');
  }
  return [];
}

export function executorClosureChecklistItems(
  session: ExperienceSessionSummary,
  _runtime: CurrentSkillRuntimeModel,
  answerKey: ExperienceSessionStoryAnswerKey,
): ExperienceChecklistItem[] {
  if (answerKey !== 'goal_satisfaction') return [];
  const hasExecution = session.indicators.toolCallCount > 0;
  const hasResult = session.indicators.assistantDeliverySignalCount > 0 || session.indicators.deliverableArtifactSignalCount > 0;
  return [
    checklistItem({
      key: 'executor_execution_to_result',
      label: hasExecution && hasResult ? '执行后有结果' : hasExecution ? '执行后结果不明确' : '未看到执行证据',
      status: hasExecution && hasResult ? 'passed' : hasExecution ? 'unknown' : 'failed',
      contribution: 'attention',
      reason: hasExecution && hasResult
        ? '看到工具执行和最终答复 / 产物线索。'
        : hasExecution
          ? '看到工具执行，但结果或产物闭环不清晰。'
          : 'executor 类型 skill 应能看到执行证据。',
      evidenceRefs: [session.evidenceChain.firstToolUse, session.evidenceChain.lastAssistantMessage],
      suggestionKey: hasExecution && hasResult ? undefined : 'executor_result_closure_review',
    }),
  ];
}

export function advisoryClosureChecklistItems(
  session: ExperienceSessionSummary,
  _runtime: CurrentSkillRuntimeModel,
  answerKey: ExperienceSessionStoryAnswerKey,
): ExperienceChecklistItem[] {
  if (answerKey !== 'goal_satisfaction') return [];
  const hasAnswer = session.indicators.assistantDeliverySignalCount > 0;
  return [
    checklistItem({
      key: 'advisory_answer_present',
      label: hasAnswer ? '已给分析结论' : '未看到分析结论',
      status: hasAnswer ? 'passed' : 'failed',
      contribution: 'attention',
      reason: hasAnswer ? '看到面向用户的分析结论或收尾回复。' : 'advisory 类型 skill 应给出清晰分析结论或阻塞说明。',
      evidenceRefs: [session.evidenceChain.lastAssistantMessage],
      suggestionKey: hasAnswer ? undefined : 'advisory_answer_absent',
    }),
  ];
}

export function downstreamFeedbackRiskChecklistItems(
  runtime: CurrentSkillRuntimeModel,
  key: string,
  presentLabel: string,
): ExperienceChecklistItem[] {
  const riskSignals = runtime.downstreamSignals.filter((signal) =>
    signal.type === 'follow_up'
    || signal.type === 'correction'
    || signal.type === 'frustration'
    || signal.type === 'interruption'
  );
  return [
    checklistItem({
      key,
      label: riskSignals.length > 0 ? presentLabel : '未见下游反馈风险',
      status: riskSignals.length > 0 ? 'failed' : 'passed',
      contribution: riskSignals.length > 0 ? 'attention' : 'neutral',
      reason: riskSignals.length > 0
        ? `看到 ${riskSignals.length} 条下游相关的用户追问、纠正或中断；这不是当前 skill 的硬失败，但需要 owner 看下闭环。`
        : '没有看到下游相关的用户反馈风险。',
      evidenceRefs: riskSignals.map((signal) => signal.evidenceRef),
      suggestionKey: riskSignals.length > 0 ? 'downstream_feedback_review' : undefined,
    }),
  ];
}

export function foldExperienceChecklistItems(items: ExperienceChecklistItem[]): { status: ExperienceReviewerReportStepStatus; reason: ExperienceParentReason; sourceItemKeys: string[] } {
  const relevant = items.filter((item) => item.contribution !== 'neutral');
  const active = relevant.length > 0 ? relevant : items;
  const degraded = active.filter((item) => item.status === 'degraded');
  if (degraded.length > 0) return { status: 'degraded', reason: 'data_degraded', sourceItemKeys: degraded.map((item) => item.key) };

  const blockingFailed = active.filter((item) => item.contribution === 'blocking' && item.status === 'failed');
  if (blockingFailed.length > 0) return { status: 'attention', reason: 'blocking_failed', sourceItemKeys: blockingFailed.map((item) => item.key) };

  const attentionFailed = active.filter((item) => item.contribution === 'attention' && item.status === 'failed');
  if (attentionFailed.length > 0) return { status: 'attention', reason: 'attention_accumulated', sourceItemKeys: attentionFailed.map((item) => item.key) };

  const unknown = active.filter((item) => item.status === 'unknown' || item.status === 'not_declared');
  const positivePassed = active.filter((item) => item.status === 'passed' && item.contribution === 'positive');
  const decisivePassed = active.filter((item) => item.status === 'passed' && (item.contribution === 'blocking' || item.contribution === 'attention' || item.contribution === 'positive'));
  const informationalPassed = active.filter((item) => item.status === 'passed' && item.contribution === 'informational');
  const passed = [...positivePassed, ...decisivePassed.filter((item) => item.contribution !== 'positive'), ...informationalPassed];
  if (unknown.length > 0 && (decisivePassed.length === 0 || unknown.length >= passed.length)) {
    return { status: 'unknown', reason: 'unknown_dominant', sourceItemKeys: unknown.map((item) => item.key) };
  }
  if (passed.length > 0) return { status: 'ok', reason: 'all_passed', sourceItemKeys: passed.map((item) => item.key) };
  return { status: 'not_applicable', reason: 'not_applicable', sourceItemKeys: active.map((item) => item.key) };
}

export interface ExpectedToolCheck {
  expectedTools: string[];
  matchedTools: string[];
  declared: boolean;
}

export function canonicalFeedbackCountsForSession(session: ExperienceSessionSummary, reviewState?: ObservationReviewState): Pick<ExperienceReviewIndicators,
  'userFollowUpCount' | 'userCorrectionCount' | 'userInterruptionCount' | 'negativeFeedbackCount' | 'positiveFeedbackCount'
> {
  const signals = session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [];
  if (signals.length === 0) {
    return {
      userFollowUpCount: session.indicators.userFollowUpCount,
      userCorrectionCount: session.indicators.userCorrectionCount,
      userInterruptionCount: session.indicators.userInterruptionCount,
      negativeFeedbackCount: session.indicators.negativeFeedbackCount,
      positiveFeedbackCount: session.indicators.positiveFeedbackCount,
    };
  }
  const owned = canonicalFeedbackSignalsForSession(session, reviewState);
  return {
    userFollowUpCount: owned.filter((signal) => signal.type === 'follow_up').length,
    userCorrectionCount: owned.filter((signal) => signal.type === 'correction').length,
    userInterruptionCount: owned.filter((signal) => signal.type === 'interruption').length,
    negativeFeedbackCount: owned.filter((signal) => signal.type === 'frustration').length,
    positiveFeedbackCount: owned.filter((signal) => signal.type === 'positive').length,
  };
}

export function canonicalFeedbackSignalsForSession(
  session: ExperienceSessionSummary,
  reviewState?: ObservationReviewState,
): ExperienceFeedbackSignal[] {
  const signals = session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [];
  const includeDownstream = shouldIncludeDownstreamFeedbackForSession(session);
  return signals.filter((signal) =>
    (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) =>
      attribution.skillName === session.skillName
      && (attribution.attributionRole === 'primary_fault'
        || includeDownstream && attribution.attributionRole === 'downstream_related')
    )
    && feedbackSignalIsActiveForSession(signal, session, reviewState)
  );
}

export function feedbackSignalIsActiveForSession(
  signal: ExperienceFeedbackSignal,
  session: ExperienceSessionSummary,
  reviewState?: ObservationReviewState,
): boolean {
  const metricKey = metricKeyForFeedbackSignal(signal);
  if (!metricKey) return true;
  const verdict = observationMetricAnnotationVerdict(reviewState, { ...signal.evidenceRef, metricScopeId: session.id }, metricKey);
  if (verdict === 'confirmed') return true;
  if (verdict === 'rejected') return false;
  return true;
}

export function metricKeyForFeedbackSignal(signal: ExperienceFeedbackSignal): ObservationMetricKey | undefined {
  if (signal.type === 'follow_up') return 'user_follow_up';
  if (signal.type === 'correction') return 'user_correction';
  if (signal.type === 'interruption') return 'user_interruption';
  if (signal.type === 'frustration') return 'negative_feedback';
  if (signal.type === 'positive') return 'positive_feedback';
  return undefined;
}

export function shouldIncludeDownstreamFeedbackForSession(session: ExperienceSessionSummary): boolean {
  const runtime = currentSkillRuntimeModel(session);
  return Boolean(runtime && (runtime.skillType === 'router' || runtime.skillType === 'delegation' || runtime.hasDownstreamEdges || runtime.isDelegator));
}

export function userFeedbackEvidenceRefs(session: ExperienceSessionSummary): ExperienceEvidenceRef[] {
  const includeDownstream = shouldIncludeDownstreamFeedbackForSession(session);
  const refs = uniqueEvidenceRefs((session.sessionStory?.episodes ?? []).flatMap((episode) =>
    (episode.feedbackSignals ?? []).filter((signal) =>
      (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) =>
        attribution.skillName === session.skillName
        && (attribution.attributionRole === 'primary_fault'
          || includeDownstream && attribution.attributionRole === 'downstream_related')
      )
    ).map((signal) => signal.evidenceRef)
  ));
  if (refs.length > 0) return refs.slice(0, 5);
  return uniqueEvidenceRefs(session.ruleFindings
    .filter((finding) => finding.code === 'user_correction_seen' || finding.code === 'negative_feedback_seen' || finding.code === 'positive_feedback_seen' || finding.code === 'user_goal_shift_seen' || finding.code === 'user_interruption_seen')
    .flatMap((finding) => finding.evidenceRefs)).slice(0, 5);
}

export function expectedToolCheckForSession(session: ExperienceSessionSummary): ExpectedToolCheck {
  const expectedTools = loadExpectedToolsForSkill(session.skillName, session.cwd);
  if (expectedTools.length === 0) return { expectedTools: [], matchedTools: [], declared: false };
  const events = session.fullSessionTimeline.length > 0 ? session.fullSessionTimeline : session.timelinePreview;
  const matchedTools = expectedTools.filter((tool) => events.some((event) => eventMatchesExpectedTool(event, tool)));
  return {
    expectedTools,
    matchedTools,
    declared: true,
  };
}

export function eventMatchesExpectedTool(event: ExperienceTimelineEvent, expectedTool: string): boolean {
  if (event.kind !== 'tool_use') return false;
  const text = `${event.toolName ?? ''}\n${event.label ?? ''}\n${event.snippet ?? ''}\n${event.fullText ?? ''}`.toLowerCase();
  const normalized = expectedTool.toLowerCase().trim();
  const aliases = unique([
    normalized,
    normalized.replace(/[-_]?cli$/, ''),
  ].filter(Boolean));
  return aliases.some((alias) => new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(alias)}([^a-z0-9_-]|$)`, 'i').test(text));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function legacyBusinessActionSource(): string {
  return ['ai', 'ma-cmd'].join('');
}
