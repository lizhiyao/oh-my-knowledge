import type {
  ExperienceChecklistItemStatus,
  ExperienceEvidenceRef,
  ExperienceInvocation,
  ExperienceReviewerReport,
  ExperienceReviewerReportFinding,
  ExperienceReviewerReportFindingLevel,
  ExperienceReviewerReportScope,
  ExperienceReviewerReportStep,
  ExperienceReviewerReportStepStatus,
  ExperienceRuleFindingCode,
  ExperienceSessionStory,
  ExperienceSessionSummary,
} from '../contracts/experience.js';
import type {
  ObservationReviewState,
} from '../contracts/review.js';
import {
  observationReviewStateKey,
} from '../inbox/review-state.js';
import {
  hashParts,
} from './primitives.js';
import {
  assistantFinalDeliveryEvents,
  assistantProgressUpdateEvents,
  currentSkillRuntimeModel,
  sumTokenUsage,
  uniqueEvidenceRefs,
  userFacingClosureForSession,
} from './report-derivations.js';
import {
  canonicalFeedbackCountsForSession,
  expectedToolCheckForSession,
  userFeedbackEvidenceRefs,
  type ExpectedToolCheck,
} from './review-checklist.js';
import {
  buildSessionStory,
  deliveryStepText,
  executionOutcomeText,
  userFeedbackStepStatus,
  userFeedbackStepText,
} from './session-story.js';

export const REVIEWER_REPORT_RULE_VERSION = 'reviewer-report.v1';

export function buildReviewerReport(
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
  const expectedToolCheck = expectedToolCheckForSession(session);
  const feedbackCounts = canonicalFeedbackCountsForSession(session, reviewState);
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
      reviewerStep(3, '执行流程', executionStepText(session, expectedToolCheck), executionStepStatus(session, expectedToolCheck), session.evidenceChain.firstToolUse ? [session.evidenceChain.firstToolUse] : []),
      reviewerStep(4, '结果 / 产物', deliveryStepText(session), userFacingClosureForSession(session).deliveryCount > 0 ? 'ok' : 'unknown', userFacingClosureForSession(session).evidenceRefs),
      reviewerStep(5, '用户反馈', userFeedbackStepText(session, reviewState), userFeedbackStepStatus(session, reviewState), userFeedbackEvidenceRefs(session)),
    ],
    findings,
      oneLookMetrics: {
      toolCallCount: indicators.toolCallCount,
      toolFailureCount: indicators.toolFailureCount,
      toolCancelledCount: indicators.toolCancelledCount ?? 0,
      toolUnknownCount: indicators.toolUnknownCount ?? 0,
      userMessageCount: indicators.userMessageCount,
      userFollowUpCount: feedbackCounts.userFollowUpCount,
      assistantDeliverySignalCount: indicators.assistantDeliverySignalCount,
      deliverableArtifactSignalCount: indicators.deliverableArtifactSignalCount,
      routerDownstreamCompleted: indicators.routerDownstreamCompleted,
      routerDownstreamFailed: indicators.routerDownstreamFailed,
      assistantProgressUpdateCount: assistantProgressUpdateEvents(session).length,
      selfCorrectionCount: indicators.selfCorrectionCount,
      repeatedExecutionCount: indicators.repeatedExecutionCount,
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

export function reviewerScopeReasonCodes(session: ExperienceSessionSummary): string[] {
  const reasons: string[] = [];
  if (session.invocationIds.length !== 1) reasons.push('multiple_invocations');
  if (session.goalSliceIds.length !== 1) reasons.push('multiple_goal_slices');
  if ((session.timelineTree?.branches.length ?? 0) > 0) reasons.push('subagent_branches_present');
  if (session.pluginNames.length > 1 || session.commandNames.length > 1) reasons.push('multiple_skill_entrypoints');
  return reasons;
}

export function reviewerStep(
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

export function userGoalStepText(session: ExperienceSessionSummary): string {
  const goal = session.evidenceChain.firstUserMessage?.snippet;
  if (!goal) return '没有看到明确人工用户目标；当前只能按运行证据做常规复盘。';
  return `用户目标：${goal}`;
}

export function skillSelectionStepText(session: ExperienceSessionSummary): string {
  const entrypoint = session.commandNames.length > 0 ? `，入口 ${session.commandNames.join('、')}` : session.entrypoint ? `，入口 ${session.entrypoint}` : '';
  return `本次使用的能力：${session.skillName}${entrypoint}。`;
}

export function executionStepStatus(session: ExperienceSessionSummary, expectedToolCheck: ExpectedToolCheck): ExperienceReviewerReportStepStatus {
  if (session.indicators.toolFailureCount > 0 || expectedToolCheck.declared && expectedToolCheck.matchedTools.length === 0) return 'attention';
  if (
    (session.indicators.toolCancelledCount ?? 0) > 0
    || (session.indicators.toolUnknownCount ?? 0) > 0
  ) return 'unknown';
  if (session.indicators.toolCallCount > 0) return 'ok';
  return 'unknown';
}

export function executionStepText(session: ExperienceSessionSummary, expectedToolCheck: ExpectedToolCheck = expectedToolCheckForSession(session)): string {
  const expected = expectedToolCheck.declared
    ? expectedToolCheck.matchedTools.length > 0
      ? `命中声明的核心工具：${expectedToolCheck.matchedTools.join('、')}。`
      : `但没有命中能力声明的核心工具：${expectedToolCheck.expectedTools.join('、')}。`
    : '';
  return `${executionOutcomeText(session.indicators)}${expected}`;
}

export function reviewerFindingsForSession(session: ExperienceSessionSummary, reviewState?: ObservationReviewState): ExperienceReviewerReportFinding[] {
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
  const expectedToolCheck = expectedToolCheckForSession(session);

  if (session.indicators.toolFailureCount > 0) {
    push(
      'attention',
      `工具调用失败 ${session.indicators.toolFailureCount} 次`,
      '执行中遇到工具报错。看下失败的步骤是否在 SKILL.md 里写明了重试或回退方式。',
      'tool_error_recovery',
      findingRefs('tool_failure_seen'),
    );
  }
  const closure = userFacingClosureForSession(session);
  const runtime = currentSkillRuntimeModel(session);
  if (closure.deliveryCount === 0) {
    const isUpstreamOrchestration = Boolean(runtime && (runtime.skillType === 'router' || runtime.skillType === 'delegation' || runtime.hasDownstreamEdges || runtime.isDelegator));
    push(
      'attention',
      isUpstreamOrchestration ? '下游结果没有回传给用户' : '没看到给用户的最终答复',
      isUpstreamOrchestration
        ? '这个 skill 已经把任务派发到下游，但没有看到下游结果被清楚回传给用户。需要确认 child 是否完成、结果是否匹配原目标、是否主动通知用户。'
        : 'assistant 没说「完成 / 结果如下」这种收尾，可能任务还没跑完，或收尾文案不够清楚让用户知道事情结束了。',
      isUpstreamOrchestration ? 'router_user_facing_closure_absent' : 'final_delivery_absent',
      closure.evidenceRefs.length > 0 ? closure.evidenceRefs : session.evidenceChain.lastAssistantMessage ? [session.evidenceChain.lastAssistantMessage] : [],
    );
  }
  if (session.indicators.sessionInterruptedCount > 0) {
    push(
      'attention',
      `会话异常断开 ${session.indicators.sessionInterruptedCount} 次`,
      '任务中途被异常中断或重启。如果是网络/超时，看是否要在 skill 里加重试；如果是程序原因，跟开发反馈。',
      'session_interrupted',
      findingRefs('session_interrupted_seen'),
    );
  }
  if (expectedToolCheck.declared && expectedToolCheck.matchedTools.length === 0) {
    push(
      'attention',
      '没用上 SKILL.md 声明的核心工具',
      `SKILL.md 里声明 ${expectedToolCheck.expectedTools.join('、')} 是核心工具，但这次没看到调用。要么 description 指引不够清楚，要么用户的诉求不属于这个 skill 的场景。`,
      'expected_tools_missed',
      session.evidenceChain.firstToolUse ? [session.evidenceChain.firstToolUse] : [],
    );
  }
  if (session.indicators.userCorrectionCount > 0) {
    push(
      'attention',
      `用户纠正 ${session.indicators.userCorrectionCount} 次`,
      '用户在过程中纠正了方向。看原文确认是 skill 理解偏差，还是 skill 不该处理这种诉求。',
      'user_correction',
      findingRefs('user_correction_seen'),
    );
  }
  if (session.indicators.userInterruptionCount > 0) {
    push(
      'attention',
      `用户手动叫停 ${session.indicators.userInterruptionCount} 次`,
      '用户主动喊停了执行。常见原因：跑偏 / 太慢 / 用错工具。看原文定位是哪一步触发的。',
      'user_interruption',
      findingRefs('user_interruption_seen'),
    );
  }
  if (session.indicators.negativeFeedbackCount > 0) {
    push(
      'attention',
      `用户说了 ${session.indicators.negativeFeedbackCount} 次不满意`,
      '用户出现了「不对 / 错了 / 不行」等负向表达。先看是 skill 给的结果不达预期，还是用户对方向本身有疑问。',
      'negative_feedback',
      findingRefs('negative_feedback_seen'),
    );
  }
  if (session.indicators.hardRuleTextHitCount > 0) {
    push(
      'note',
      `用户提了 ${session.indicators.hardRuleTextHitCount} 次硬性要求`,
      '用户在对话里强调了某些必须做/不能做的规则。如果同类要求反复出现，可以沉淀到 SKILL.md 的 hardRules。',
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
      '没有看到需要优先关注的纠正、中断、负向反馈、工具失败或没收尾的信号。',
      'no_priority_signal',
      [],
    );
  }
  return findings;
}

export function reviewerTitle(session: ExperienceSessionSummary, attentionCount: number, possibleFalsePositiveCount: number): string {
  const suffix = possibleFalsePositiveCount > 0 ? ` · ${possibleFalsePositiveCount} 项疑似误判` : '';
  if (attentionCount > 0) return `${session.skillName} · ${attentionCount} 项要看一眼${suffix}`;
  if (session.indicators.assistantDeliverySignalCount > 0) return `${session.skillName} · 看起来有结果 · 常规抽样${suffix}`;
  return `${session.skillName} · 常规抽样 · 未见高优先级信号${suffix}`;
}

export function reviewerSummary(
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

export function reviewerAuthorSuggestions(session: ExperienceSessionSummary, findings: ExperienceReviewerReportFinding[]): string[] {
  const suggestions = new Map<string, { text: string; severity: number }>();
  const pushSuggestion = (key: string, text: string, severity: number): void => {
    const existing = suggestions.get(key);
    if (!existing || severity > existing.severity) suggestions.set(key, { text, severity });
  };
  for (const answer of session.sessionStory?.answers ?? []) {
    for (const item of answer.checklistItems ?? []) {
      if (!item.suggestionKey) continue;
      const text = suggestionTextForChecklistItem(item.suggestionKey);
      if (!text) continue;
      pushSuggestion(item.suggestionKey, text, severityForChecklistStatus(item.status));
    }
  }
  if (findings.some((finding) => finding.ruleSource === 'router_user_facing_closure_absent')) {
    pushSuggestion('router_user_facing_closure_absent', '补充下游结果回传和异步闭环规范，避免路由能力只负责启动、不负责结果回收。', 4);
  } else if (findings.some((finding) => finding.ruleSource === 'final_delivery_absent')) {
    pushSuggestion('final_delivery_absent', '补充明确的产物交付表达或交付标记，避免过程进展被当成完成。', 4);
  }
  if (findings.some((finding) => finding.ruleSource === 'tool_error_recovery')) {
    pushSuggestion('tool_error_recovery', '复查失败工具调用前后的执行流程，必要时把稳定路径写入能力说明文档。', 4);
  }
  if (findings.some((finding) => finding.ruleSource === 'session_interrupted')) {
    pushSuggestion('session_interrupted', '复查会话异常中断前后的上下文，确认是否需要补充中断恢复或重跑策略。', 4);
  }
  if (findings.some((finding) => finding.ruleSource === 'expected_tools_missed')) {
    pushSuggestion('expected_tools_missed', '如果能力依赖核心工具，请在能力定义里维护 expected_tools，并确认运行链路实际命中这些工具。', 4);
  }
  if (session.indicators.hardRuleTextHitCount > 0) {
    pushSuggestion('user_hard_rule', '把反复出现的用户硬性要求沉淀为能力规则，并在后续观测中追踪是否减少纠偏。', 2);
  }
  if (session.indicators.userCorrectionCount > 0 || session.indicators.negativeFeedbackCount > 0) {
    pushSuggestion('user_negative_review', '优先打开原始片段，确认用户纠正/负向反馈发生在交付前还是交付后。', 4);
  }
  if (reviewerScopeReasonCodes(session).length > 0) {
    pushSuggestion('complex_scope_review', '复杂链路暂按降级报告处理；后续再拆多能力、子任务或目标切换。', 1);
  }
  if (suggestions.size === 0) pushSuggestion('routine_sample', '进入常规抽样池，保留 evidenceRef 以便人工抽查。', 0);
  return Array.from(suggestions.values())
    .sort((a, b) => b.severity - a.severity || a.text.localeCompare(b.text))
    .map((entry) => entry.text);
}

export function severityForChecklistStatus(status: ExperienceChecklistItemStatus): number {
  if (status === 'degraded') return 5;
  if (status === 'failed') return 4;
  if (status === 'unknown') return 3;
  if (status === 'not_declared') return 2;
  if (status === 'passed') return 1;
  return 0;
}

export function suggestionTextForChecklistItem(key: string): string | undefined {
  const suggestions: Record<string, string> = {
    final_delivery_absent: '在最后回复里加上「已完成 / 结果如下」之类的明确收尾，让用户知道任务跑完了。',
    router_user_facing_closure_absent: '在路由 / 调度能力里写清楚：下游完成后必须回收结果并同步给用户；如果未完成，要说明当前状态和下一步。',
    artifact_absent: '如果 skill 应该产出文档、demo、代码或报告，最终回复里要附上文件路径、链接或代码块。',
    goal_shift_review: '用户中途切了目标，后续追问不属于这个 skill。看下是否要在 description 里说清楚 skill 的边界。',
    user_negative_or_interrupted: '用户出现了不满 / 纠正 / 叫停。先看原文是哪一步触发的，再决定改 description、补标准流程还是补硬性规则。',
    workflow_not_declared: '在 SKILL.md 里补一个标准流程声明，把这个 skill 的执行步骤写清楚。否则报告只能猜流程是否完整。',
    workflow_execution_review: '声明了标准流程但执行证据不够。补一下每个步骤的输出形态，让运行时能验证是否真的跑过。',
    hardrule_not_declared: '在 SKILL.md 里补硬性规则声明，把那些「必须做 / 不能做」的约束写明。',
    hardrule_execution_review: '声明了硬性规则但执行证据不够。补一下每条规则的触发场景，让运行时能验证。',
    expected_tools_not_declared: '在 SKILL.md frontmatter 里声明 expected_tools。否则报告分不出「真用上了 skill 工具」还是「只是随便调了个工具」。',
    expected_tools_missed: '声明了核心工具但没用上。先确认 description 是否清楚指引到这些工具，或者用户的诉求不属于这个 skill。',
    negative_feedback_review: '打开用户负向反馈的原文，看问题出在理解目标、执行过程还是最后没收尾。',
    user_correction_review: '用户纠正了多次。把纠正内容沉淀到 SKILL.md 的标准流程或硬性规则，避免下次同类返工。',
    follow_up_review: '用户追问比较多。看是围绕产物继续推进（好事），还是因为没拿到结果而反复问（要改）。',
    user_interruption_review: '用户叫停了执行。看下断的那一步是不是 skill 没声明标准流程导致跑偏。',
    downstream_feedback_review: '这次任务的下游执行链路被用户追问、纠正或中断。路由 / 调度类 skill 需要把下游状态、结果回收和异常通知写清楚，避免只负责启动、不负责闭环。',
  };
  return suggestions[key];
}
