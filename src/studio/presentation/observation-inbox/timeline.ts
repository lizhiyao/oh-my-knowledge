import { e } from '../layout.js';
import {
  ASSISTANT_DELIVERABLE_ARTIFACT_RE,
  HARD_RULE_TEXT_RE,
  hasAssistantDeliverableArtifactText,
  hasAssistantDeliverySignalText,
  hasUserHardRuleText,
  isAssistantProgressUpdateText,
  isScheduledTaskPromptText,
  isSyntheticUserMessageText,
  isUserInteractionMetricText,
  observationMetricAnnotationEntry,
  observationMetricAnnotationTargetId,
} from '../../../observability/inbox-view-model.js';
import type {
  ObservationInboxViewModel,
  ObservationMetricKey,
} from '../../../observability/inbox-view-model.js';
import {
  findNegativeFeedbackMatches,
  findPositiveFeedbackMatches,
  findUserCorrectionMatches,
  findUserGoalShiftMatches,
  hasUserCorrectionSignal,
  hasUserGoalShiftSignal,
} from '../../../observability/feedback-projection.js';
import type {
  ExperienceFeedbackSignal,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from '../../../observability/feedback-projection.js';

interface ObservationTimelineDependencies {
  experience: ObservationInboxViewModel['experienceReports'][number] | undefined;
  reviewState: ObservationInboxViewModel['reviewState'];
  canonicalFeedbackSignalsForDisplay(session: ExperienceSessionSummary): ExperienceFeedbackSignal[];
  reviewStateKey(targetType: string, targetId: string): string;
  shouldIncludeDownstreamFeedbackForDisplay(session: ExperienceSessionSummary): boolean;
}

interface ObservationTimelinePresentation {
  renderTimelinePair(session: ExperienceSessionSummary): string;
}

const isAssistantDeliverySignal = (event: ExperienceTimelineEvent): boolean => {
	  if (event.kind !== 'assistant_message') return false;
	  const text = event.fullText ?? event.snippet ?? '';
	  return hasAssistantDeliverySignalText(text);
	};

export const isAssistantCompletionResultSignal = (event: ExperienceTimelineEvent): boolean => isAssistantDeliverySignal(event);

export const isAssistantDeliverableArtifactSignal = (event: ExperienceTimelineEvent): boolean => {
	  if (event.kind !== 'assistant_message') return false;
	  const text = event.fullText ?? event.snippet ?? '';
	  return hasAssistantDeliverableArtifactText(text);
	};

export function hasSelfCorrectionSignal(event: ExperienceTimelineEvent): boolean {
	  if (event.kind !== 'assistant_message') return false;
	  const text = event.fullText ?? event.snippet ?? '';
	  return /刚才.*(?:不对|错了|有误)|发现.*(?:不对|错了|问题|遗漏)|重新(?:检查|分析|执行|生成|整理)|改用|换成|修正|我再(?:检查|重新|看)|\b(?:recheck|retry|rerun|mistake|wrong)\b/i.test(text);
	}

export function hasRepeatedExecutionSignal(event: ExperienceTimelineEvent): boolean {
	  if (event.kind !== 'assistant_message' && event.kind !== 'tool_use') return false;
	  const text = `${event.label ?? ''} ${event.toolName ?? ''} ${event.fullText ?? event.snippet ?? ''}`;
	  return /重复(?:执行|尝试|读取|搜索|调用)|再次(?:执行|读取|搜索|调用)|重新(?:执行|读取|搜索|调用|跑|运行)|再(?:执行|读取|搜索|调用|跑)一遍|重试|\b(?:retry|rerun)\b/i.test(text);
	}

export function createObservationTimelineRenderers({
  experience,
  reviewState,
  canonicalFeedbackSignalsForDisplay,
  reviewStateKey,
  shouldIncludeDownstreamFeedbackForDisplay,
}: ObservationTimelineDependencies): ObservationTimelinePresentation {
  interface TimelineEventMeta {
    icon: string;
    label: string;
    tone: string;
  }
  interface TimelineRenderOptions {
    reviewSessionId?: string;
    currentSkillName?: string;
    includeDownstreamFeedback?: boolean;
    feedbackSignals?: ExperienceFeedbackSignal[];
    activeEventIds?: Set<string>;
    showSkillWindowMarkers?: boolean;
    suppressMetricTagsOutsideSkillWindow?: boolean;
  }
  interface TimelineHighlightRule {
    pattern?: RegExp;
    ranges?: (value: string) => Array<{ start: number; end: number }>;
    className: string;
    title: string;
  }
  const USER_INTERRUPTION_RE = /\[Request interrupted by user(?: for tool use)?\]|interrupted by user|用户中断/i;
  const HARD_RULE_RE = HARD_RULE_TEXT_RE;
  const HEDGING_RE = /可能|不确定|需要确认|大概|也许|presumably|maybe|unclear|not sure/i;
  const EXPLICIT_MARKER_RE = /【推断】|【知识缺口】|【未知】|\[inferred\]|\[unknown\]|\[knowledge\s*gap\]/i;
  const TOOL_FAILURE_RE = /Error|error|failed|失败|Exception|ENOENT|EACCES|permission denied|No such file|exceeds maximum allowed tokens|timed out|timeout/i;
  const DELIVERABLE_ARTIFACT_RE = ASSISTANT_DELIVERABLE_ARTIFACT_RE;
  const evidenceMetricLabels: Record<ObservationMetricKey, string> = {
    user_correction: '纠正',
    user_interruption: '中断',
    user_follow_up: '追问',
    negative_feedback: '负向',
    positive_feedback: '正向',
    hard_rule: '用户硬性要求',
    user_goal_shift: '目标切换',
    result_artifact: '产出结果（旧）',
    completion_result: '有结果',
    deliverable_artifact: '有产物',
    progress_update: '过程进展',
    self_correction: '自我纠正',
    repeated_execution: '重复执行',
  };
  const cloneRegex = (pattern: RegExp): RegExp => new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const matches = (pattern: RegExp, value: string): boolean => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  };
  const highlightText = (value: string, rules: TimelineHighlightRule[]): string => {
    if (!value || rules.length === 0) return e(value);
    const ranges: Array<{ start: number; end: number; className: string; title: string }> = [];
    for (const rule of rules) {
      const matches = rule.ranges
        ? rule.ranges(value)
        : rule.pattern
          ? Array.from(value.matchAll(rule.pattern)).map((match) => {
            const text = match[0] ?? '';
            const start = match.index ?? -1;
            return { start, end: start + text.length };
          })
          : [];
      for (const match of matches) {
        const start = match.start;
        const end = match.end;
        if (start < 0 || ranges.some((range) => start < range.end && end > range.start)) continue;
        ranges.push({ start, end, className: rule.className, title: rule.title });
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    let cursor = 0;
    const parts: string[] = [];
    for (const range of ranges) {
      parts.push(e(value.slice(cursor, range.start)));
      parts.push(`<mark class="timeline-mark ${range.className}" title="${e(range.title)}">${e(value.slice(range.start, range.end))}</mark>`);
      cursor = range.end;
    }
    parts.push(e(value.slice(cursor)));
    return parts.join('');
  };
  const timelineEventMeta = (event: ExperienceTimelineEvent): TimelineEventMeta => {
	    if (event.kind === 'user_message') return { icon: 'U', label: '用户消息', tone: 'user' };
	    if (event.kind === 'synthetic_user_event') return { icon: 'S', label: '构造事件', tone: 'runtime' };
	    if (event.kind === 'assistant_message') return { icon: 'A', label: '助手回复', tone: 'assistant' };
	    if (event.kind === 'tool_use') return { icon: 'TU', label: '工具调用', tone: 'tool-use' };
	    if (event.kind === 'tool_result') {
	      if (event.toolStatus === 'failure' || (event.toolStatus === undefined && event.isError)) return { icon: 'TR', label: '工具执行失败', tone: 'tool-error' };
	      if (event.toolStatus === 'cancelled') return { icon: 'TR', label: '工具调用取消', tone: 'runtime' };
	      if (event.toolStatus === 'unknown') return { icon: 'TR', label: '工具状态未知', tone: 'runtime' };
	      return { icon: 'TR', label: isSkillLaunchResult(event) ? '工具调用成功' : '工具执行成功', tone: 'tool-result' };
	    }
	    if (event.kind === 'skill_context') return { icon: 'S', label: 'Skill 注入上下文', tone: 'skill' };
	    if (event.kind === 'runtime_context') return { icon: 'R', label: event.label === 'command envelope' ? '命令注入上下文' : '运行时注入上下文', tone: 'skill' };
	    if (event.kind === 'lifecycle') return { icon: 'L', label: '运行状态', tone: 'runtime' };
	    return { icon: 'O', label: '过程发现', tone: 'observation' };
	  };
  const isSkillLaunchResult = (event: ExperienceTimelineEvent): boolean =>
	    event.kind === 'tool_result' && /^Launching skill:/i.test((event.fullText ?? event.snippet ?? '').trim());
  const isAssistantProgressUpdateSignal = (event: ExperienceTimelineEvent): boolean => {
	    if (event.kind !== 'assistant_message') return false;
	    const text = event.fullText ?? event.snippet ?? '';
	    return isAssistantProgressUpdateText(text);
	  };
  const evidenceMetricVerdictFor = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, metricScopeId?: string): 'confirmed' | 'rejected' | '' => {
	    const entry = observationMetricAnnotationEntry(
	      reviewState,
	      { ...event, metricScopeId },
	      metricKey,
	    );
	    return entry?.verdict === 'confirmed' || entry?.verdict === 'rejected' ? entry.verdict : '';
	  };
  const evidenceMetricIsActive = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, ruleDetected: boolean, metricScopeId?: string): boolean => {
	    const verdict = evidenceMetricVerdictFor(event, metricKey, metricScopeId);
	    if (verdict === 'confirmed') return true;
	    if (verdict === 'rejected') return false;
	    return ruleDetected;
	  };
  const evidenceMetricBadgeLabel = (base: string, event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, ruleDetected: boolean, metricScopeId?: string): string =>
	    evidenceMetricVerdictFor(event, metricKey, metricScopeId) === 'confirmed' && !ruleDetected ? `人工确认：${base}` : base;
  const feedbackSignalMatchesEvent = (signal: ExperienceFeedbackSignal, event: ExperienceTimelineEvent): boolean => {
    const ref = signal.evidenceRef;
    if (ref.messageUuid && event.messageUuid && ref.messageUuid === event.messageUuid) return true;
    return ref.sourceTrace === event.sourceTrace
      && typeof ref.messageIndex === 'number'
      && typeof event.messageIndex === 'number'
      && ref.messageIndex === event.messageIndex;
  };
  const feedbackSignalTag = (type?: string): string | undefined => {
    if (type === 'correction') return 'user_correction';
    if (type === 'follow_up') return 'user_follow_up';
    if (type === 'frustration') return 'negative_feedback';
    if (type === 'interruption') return 'user_interruption';
    if (type === 'positive') return 'positive_feedback';
    return undefined;
  };
  const canonicalFeedbackSignalsForEvent = (
    event: ExperienceTimelineEvent,
    skillName?: string,
    feedbackSignals: ExperienceFeedbackSignal[] = [],
    includeDownstreamFeedback = false,
  ): ExperienceFeedbackSignal[] => {
    if (!skillName || feedbackSignals.length === 0) return [];
    return feedbackSignals.filter((signal) =>
      feedbackSignalMatchesEvent(signal, event)
      && (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) =>
        attribution.skillName === skillName
        && (
          attribution.attributionRole === 'primary_fault'
          || includeDownstreamFeedback && attribution.attributionRole === 'downstream_related'
        )
      )
    );
  };
  const timelineSearchTags = (
    event: ExperienceTimelineEvent,
    userIndex: number,
    allowMetricTags: boolean,
    metricScopeId?: string,
    currentSkillName?: string,
    feedbackSignals: ExperienceFeedbackSignal[] = [],
    includeDownstreamFeedback = false,
  ): string[] => {
    if (!allowMetricTags) return [];
    const text = event.fullText ?? event.snippet ?? '';
    const metricText = event.snippet ?? '';
    const tags: string[] = [];
    if (event.kind === 'user_message') {
      const syntheticUser = isSyntheticUserMessageText(metricText);
      if (syntheticUser) tags.push('synthetic_user_message');
      else tags.push('user_message');
      if (isScheduledTaskPromptText(metricText)) tags.push('scheduled_task');
      if (isUserInteractionMetricText(metricText)) {
        if (evidenceMetricIsActive(event, 'user_follow_up', userIndex > 0 && !hasUserGoalShiftSignal(metricText), metricScopeId)) tags.push('user_follow_up');
        if (evidenceMetricIsActive(event, 'user_correction', hasUserCorrectionSignal(metricText), metricScopeId)) tags.push('user_correction');
        if (evidenceMetricIsActive(event, 'user_goal_shift', hasUserGoalShiftSignal(metricText), metricScopeId)) tags.push('user_goal_shift');
        if (evidenceMetricIsActive(event, 'user_interruption', matches(USER_INTERRUPTION_RE, metricText), metricScopeId)) tags.push('user_interruption');
        if (evidenceMetricIsActive(event, 'negative_feedback', findNegativeFeedbackMatches(metricText).length > 0)) tags.push('negative_feedback');
        if (evidenceMetricIsActive(event, 'positive_feedback', findPositiveFeedbackMatches(metricText).length > 0)) tags.push('positive_feedback');
        if (evidenceMetricIsActive(event, 'hard_rule', hasUserHardRuleText(metricText), metricScopeId)) tags.push('hard_rule');
      }
      for (const signal of canonicalFeedbackSignalsForEvent(event, currentSkillName, feedbackSignals, includeDownstreamFeedback)) {
        const tag = feedbackSignalTag(signal.type);
        if (tag) tags.push(tag);
      }
    }
    if (event.kind === 'assistant_message') {
      if (evidenceMetricIsActive(event, 'completion_result', isAssistantCompletionResultSignal(event))) tags.push('completion_result');
      if (evidenceMetricIsActive(event, 'deliverable_artifact', isAssistantDeliverableArtifactSignal(event))) tags.push('deliverable_artifact');
      if (evidenceMetricIsActive(event, 'self_correction', hasSelfCorrectionSignal(event))) tags.push('self_correction');
      if (evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) tags.push('repeated_execution');
      if (matches(HEDGING_RE, text)) tags.push('hedging');
      if (matches(EXPLICIT_MARKER_RE, text)) tags.push('explicit_marker');
    }
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message' && evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) tags.push('repeated_execution');
    if (event.kind === 'tool_result' && event.isError) tags.push('tool_failure');
    if (event.kind === 'observation') tags.push('observation');
    return Array.from(new Set(tags));
  };
  const timelineMetricBadges = (
    event: ExperienceTimelineEvent,
    userIndex: number,
    allowMetricTags = true,
    metricScopeId?: string,
    currentSkillName?: string,
    feedbackSignals: ExperienceFeedbackSignal[] = [],
    includeDownstreamFeedback = false,
  ): string[] => {
    if (!allowMetricTags) return [];
	    const text = event.fullText ?? event.snippet ?? '';
	    const metricText = event.snippet ?? '';
    const badges: Array<{ label: string; className: string; title: string }> = [];
    if (event.kind === 'user_message') {
      const scheduledTask = isScheduledTaskPromptText(metricText);
      const syntheticUser = isSyntheticUserMessageText(metricText);
      badges.push({
        label: syntheticUser ? '系统构造消息（不计用户交互）' : scheduledTask ? '用户消息来源（定时任务）' : '用户消息来源',
        className: syntheticUser ? 'metric-skill-context' : scheduledTask ? 'metric-user-message metric-scheduled-task' : 'metric-user-message',
        title: syntheticUser
          ? '这是 trace 后处理或工作流系统注入的伪 user message，不计入真实用户消息、追问、纠正或硬性要求。'
          : scheduledTask
          ? '这是 cron 定时任务注入的用户侧任务入口，保留为用户消息来源，但不参与追问、负向反馈、硬性要求等人工交互指标。'
          : '这条人工用户消息计入用户消息数；同一 skill 片段内第 2 条及之后还会计入追问/补充。',
      });
      if (isUserInteractionMetricText(metricText)) {
        if (evidenceMetricIsActive(event, 'user_follow_up', userIndex > 0 && !hasUserGoalShiftSignal(metricText), metricScopeId)) badges.push({ label: evidenceMetricBadgeLabel('追问/补充来源', event, 'user_follow_up', userIndex > 0 && !hasUserGoalShiftSignal(metricText), metricScopeId), className: 'metric-followup', title: '同一 skill 复盘片段内，第 2 条及之后的人工用户消息计入追问/补充；目标切换消息不计入追问。' });
        if (evidenceMetricIsActive(event, 'user_correction', hasUserCorrectionSignal(metricText), metricScopeId)) badges.push({ label: evidenceMetricBadgeLabel('用户纠正来源', event, 'user_correction', hasUserCorrectionSignal(metricText), metricScopeId), className: 'metric-correction', title: '命中明确纠正表达；“不对/不是/错了”要求前后有标点、空格等分隔。人工反对后不会再显示。' });
        if (evidenceMetricIsActive(event, 'user_goal_shift', hasUserGoalShiftSignal(metricText), metricScopeId)) badges.push({ label: evidenceMetricBadgeLabel('目标切换来源', event, 'user_goal_shift', hasUserGoalShiftSignal(metricText), metricScopeId), className: 'metric-goal-shift', title: '命中“换个方向/先不/不用这个/另一个问题”等表达；表示用户可能切走当前目标。' });
        if (evidenceMetricIsActive(event, 'user_interruption', matches(USER_INTERRUPTION_RE, metricText), metricScopeId)) badges.push({ label: evidenceMetricBadgeLabel('人工中断来源', event, 'user_interruption', matches(USER_INTERRUPTION_RE, metricText), metricScopeId), className: 'metric-interruption', title: '用户主动中断了当前执行，通常表示当前路径需要纠偏或停止。' });
        if (evidenceMetricIsActive(event, 'negative_feedback', findNegativeFeedbackMatches(metricText).length > 0)) badges.push({ label: evidenceMetricBadgeLabel('负向反馈来源', event, 'negative_feedback', findNegativeFeedbackMatches(metricText).length > 0), className: 'metric-negative', title: '命中“没用/垃圾/菜/做错了/不行/看不懂”等负向表达。' });
        if (evidenceMetricIsActive(event, 'positive_feedback', findPositiveFeedbackMatches(metricText).length > 0)) badges.push({ label: evidenceMetricBadgeLabel('正向反馈来源', event, 'positive_feedback', findPositiveFeedbackMatches(metricText).length > 0), className: 'metric-positive', title: '命中“很好/good job/做得好/很棒/优秀/很有用”等正向表达。' });
        if (evidenceMetricIsActive(event, 'hard_rule', hasUserHardRuleText(metricText), metricScopeId)) badges.push({ label: evidenceMetricBadgeLabel('用户硬性要求来源', event, 'hard_rule', hasUserHardRuleText(metricText), metricScopeId), className: 'metric-hard-rule', title: '命中“必须/不要/禁止/严格”等用户临时硬性要求。' });
      }
      const canonicalTypes = new Set(canonicalFeedbackSignalsForEvent(event, currentSkillName, feedbackSignals, includeDownstreamFeedback).map((signal) => signal.type));
      if (canonicalTypes.has('correction') && !badges.some((badge) => badge.className === 'metric-correction')) {
        badges.push({ label: '用户纠正来源（归因）', className: 'metric-correction', title: '这条消息被任务执行归因模型判定为当前 skill 的用户纠正来源。' });
      }
      if (canonicalTypes.has('follow_up') && !badges.some((badge) => badge.className === 'metric-followup')) {
        badges.push({ label: '追问/补充来源（归因）', className: 'metric-followup', title: '这条消息被任务执行归因模型判定为当前 skill 的追问/补充来源。' });
      }
      if (canonicalTypes.has('frustration') && !badges.some((badge) => badge.className === 'metric-negative')) {
        badges.push({ label: '负向反馈来源（归因）', className: 'metric-negative', title: '这条消息被任务执行归因模型判定为当前 skill 的负向反馈来源。' });
      }
      if (canonicalTypes.has('interruption') && !badges.some((badge) => badge.className === 'metric-interruption')) {
        badges.push({ label: '人工中断来源（归因）', className: 'metric-interruption', title: '这条消息被任务执行归因模型判定为当前 skill 的人工中断来源。' });
      }
      if (canonicalTypes.has('positive') && !badges.some((badge) => badge.className === 'metric-positive')) {
        badges.push({ label: '正向反馈来源（归因）', className: 'metric-positive', title: '这条消息被任务执行归因模型判定为当前 skill 的正向反馈来源。' });
      }
    }
	    if (event.kind === 'assistant_message') {
	      if (evidenceMetricIsActive(event, 'completion_result', isAssistantCompletionResultSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('有结果', event, 'completion_result', isAssistantCompletionResultSignal(event)), className: 'metric-completion', title: '助手回复里出现明确完成态或结果反馈，表示任务可能已有执行结果。它不等于一定交付了可打开的文档、链接或文件。' });
	      if (evidenceMetricIsActive(event, 'deliverable_artifact', isAssistantDeliverableArtifactSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('有产物', event, 'deliverable_artifact', isAssistantDeliverableArtifactSignal(event)), className: 'metric-completion', title: '助手回复里出现可交付对象，例如文档链接、Demo 地址、文件路径、代码块或上传产物。' });
	      if (evidenceMetricIsActive(event, 'self_correction', hasSelfCorrectionSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('自我纠正', event, 'self_correction', hasSelfCorrectionSignal(event)), className: 'metric-correction', title: 'agent 在没有用户介入的情况下发现问题并主动修正执行策略。少量说明有恢复能力，高频说明流程不稳。' });
	      if (evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('重复执行', event, 'repeated_execution', hasRepeatedExecutionSignal(event)), className: 'metric-repeated-execution', title: '同类步骤、工具或流程被重复执行。高频出现时通常对应绕路或 workflow 不清晰。' });
	      if (matches(HEDGING_RE, text)) badges.push({ label: '不确定表达来源', className: 'metric-hedging', title: '命中“可能/不确定/需要确认”等表达。' });
	      if (matches(EXPLICIT_MARKER_RE, text)) badges.push({ label: '显式缺口来源', className: 'metric-explicit', title: '命中“【推断】/【未知】/知识缺口”等标记。' });
    }
    if (event.kind === 'tool_use') {
      if (evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('重复执行', event, 'repeated_execution', hasRepeatedExecutionSignal(event)), className: 'metric-repeated-execution', title: '同类工具或流程被重复调用。高频出现时通常对应绕路或 workflow 不清晰。' });
      badges.push({
        label: '工具调用',
        className: 'metric-tool-use',
        title: event.toolName
          ? `这条记录表示 agent 调用了一个工具。原始工具名：${event.toolName}。`
          : '这条记录表示 agent 调用了一个工具。',
      });
    }
	    if (event.kind === 'tool_result') {
	      if (evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) badges.push({ label: evidenceMetricBadgeLabel('重复执行', event, 'repeated_execution', hasRepeatedExecutionSignal(event)), className: 'metric-repeated-execution', title: '同类工具结果或失败恢复路径被重复出现。高频出现时通常对应绕路或 workflow 不清晰。' });
	      if (event.toolStatus === 'failure' || (event.toolStatus === undefined && event.isError)) {
	        badges.push({ label: '工具执行失败', className: 'metric-tool-failure', title: 'tool_result 标记 is_error=true，表示这次工具执行失败。' });
	      } else if (event.toolStatus === 'cancelled') {
	        badges.push({ label: '工具调用取消', className: 'metric-neutral', title: 'runtime 明确标记这次工具调用已取消；它不计作工具执行失败。' });
	      } else if (event.toolStatus === 'unknown') {
	        badges.push({ label: '工具状态未知', className: 'metric-neutral', title: 'runtime 没有提供可确认的成功或失败状态；这次调用不计入工具成功率分母。' });
	      } else if (isSkillLaunchResult(event)) {
	        badges.push({ label: '工具调用成功', className: 'metric-tool-success', title: 'Launching skill 表示 Skill 工具调用已被 runtime 接受并启动；这不是 skill 执行结束。' });
	      } else {
	        badges.push({ label: '工具执行成功', className: 'metric-tool-success', title: '这条 tool_result 没有错误标记，表示这次工具执行返回成功结果。' });
	      }
	    }
    if (event.kind === 'skill_context') {
      badges.push({ label: '不计入用户交互', className: 'metric-skill-context', title: '这是 Skill runtime 注入的 SKILL.md 内容，不计入用户消息、追问、纠正或负向反馈。' });
    }
    if (event.kind === 'runtime_context') {
      badges.push({ label: '不计入用户交互', className: 'metric-skill-context', title: event.label === 'command envelope' ? '这是斜杠命令的系统包装内容，不是人工用户原话，不计入用户消息、追问、纠正、情绪反馈或用户硬性要求。' : '这是 SDK/工作台注入的运行时上下文，不是人工用户原话，不计入用户消息、追问、纠正、情绪反馈或用户硬性要求。' });
    }
    if (event.kind === 'lifecycle') {
      badges.push({ label: '运行状态', className: 'metric-neutral', title: '这是 runtime 记录的生命周期状态，不是模型上下文，也不计入用户交互。' });
    }
    if (event.kind === 'observation') {
      badges.push({ label: '过程发现来源', className: 'metric-explicit', title: '这条事件来自 observation 信号，会进入过程发现类指标。' });
    }
    if (badges.length === 0 && event.kind !== 'assistant_message') {
      badges.push({ label: '上下文事件', className: 'metric-neutral', title: '这条时间线事件用于回溯上下文，当前没有额外指标判断。' });
    }
    return badges.map((badge) => `<span class="timeline-badge ${badge.className}" title="${e(badge.title)}">${e(badge.label)}</span>`);
  };
  const highlightTimelineSnippet = (event: ExperienceTimelineEvent, userIndex: number, allowMetricTags = true, metricScopeId?: string): string => {
	    const rules: TimelineHighlightRule[] = [];
	    const value = event.snippet ?? '';
    if (!allowMetricTags) return e(value);
	    if (event.kind === 'user_message' && isUserInteractionMetricText(value)) {
      if (evidenceMetricIsActive(event, 'user_correction', hasUserCorrectionSignal(value), metricScopeId)) rules.push({ ranges: findUserCorrectionMatches, className: 'metric-correction', title: '用户纠正命中词' });
      if (evidenceMetricIsActive(event, 'user_goal_shift', hasUserGoalShiftSignal(value), metricScopeId)) rules.push({ ranges: findUserGoalShiftMatches, className: 'metric-goal-shift', title: '目标切换命中词' });
      if (evidenceMetricIsActive(event, 'user_interruption', matches(USER_INTERRUPTION_RE, value), metricScopeId)) rules.push({ pattern: cloneRegex(USER_INTERRUPTION_RE), className: 'metric-interruption', title: '人工中断命中词' });
      if (evidenceMetricIsActive(event, 'negative_feedback', findNegativeFeedbackMatches(value).length > 0)) rules.push({ ranges: findNegativeFeedbackMatches, className: 'metric-negative', title: '负向反馈命中词' });
      if (evidenceMetricIsActive(event, 'positive_feedback', findPositiveFeedbackMatches(value).length > 0)) rules.push({ ranges: findPositiveFeedbackMatches, className: 'metric-positive', title: '正向反馈命中词' });
      if (evidenceMetricIsActive(event, 'hard_rule', hasUserHardRuleText(value), metricScopeId)) rules.push({ pattern: cloneRegex(HARD_RULE_RE), className: 'metric-hard-rule', title: '用户硬性要求命中词' });
    }
	    if (event.kind === 'assistant_message') {
	      rules.push(
	        { pattern: /直接生成|已生成|生成如下|结果如下|完成|已完成/g, className: 'metric-completion', title: '有结果命中词' },
	        { pattern: cloneRegex(DELIVERABLE_ARTIFACT_RE), className: 'metric-completion', title: '有产物命中词' },
	        { pattern: /刚才.*(?:不对|错了|有误)|发现.*(?:不对|错了|问题|遗漏)|重新(?:检查|分析|执行|生成|整理)|改用|换成|修正|我再(?:检查|重新|看)|recheck|retry|mistake|wrong/gi, className: 'metric-correction', title: '自我纠正命中词' },
	        { pattern: /重复(?:执行|尝试|读取|搜索|调用)|再次(?:执行|读取|搜索|调用)|重新(?:执行|读取|搜索|调用|跑|运行)|再(?:执行|读取|搜索|调用|跑)一遍|重试|retry|rerun/gi, className: 'metric-repeated-execution', title: '重复执行命中词' },
	        { pattern: cloneRegex(HEDGING_RE), className: 'metric-hedging', title: '不确定表达命中词' },
	        { pattern: cloneRegex(EXPLICIT_MARKER_RE), className: 'metric-explicit', title: '显式缺口命中词' },
	      );
	    }
    if (event.kind !== 'user_message' && event.kind !== 'assistant_message' && evidenceMetricIsActive(event, 'repeated_execution', hasRepeatedExecutionSignal(event))) {
      rules.push({ pattern: /重复(?:执行|尝试|读取|搜索|调用)|再次(?:执行|读取|搜索|调用)|重新(?:执行|读取|搜索|调用|跑|运行)|再(?:执行|读取|搜索|调用|跑)一遍|重试|retry|rerun/gi, className: 'metric-repeated-execution', title: '重复执行命中词' });
    }
    if (event.kind === 'tool_result' && event.isError) {
      rules.push({ pattern: cloneRegex(TOOL_FAILURE_RE), className: 'metric-tool-failure', title: '工具执行失败命中词' });
    }
	    const html = highlightText(value, rules);
    if (event.kind === 'user_message' && isUserInteractionMetricText(value) && evidenceMetricIsActive(event, 'user_follow_up', userIndex > 0 && !hasUserGoalShiftSignal(value), metricScopeId)) {
      return `<span class="timeline-followup-source" title="整条消息计入追问/补充来源">${html}</span>`;
    }
    return html;
  };
  const evidenceMetricRuleDetected = (event: ExperienceTimelineEvent, userIndex: number, metricKey: ObservationMetricKey): boolean => {
    const text = event.snippet ?? '';
    if (event.kind === 'user_message' && !isUserInteractionMetricText(text)) return false;
    if (metricKey === 'user_correction') return hasUserCorrectionSignal(text);
    if (metricKey === 'user_interruption') return matches(USER_INTERRUPTION_RE, text);
    if (metricKey === 'user_follow_up') return userIndex > 0 && !hasUserGoalShiftSignal(text);
    if (metricKey === 'negative_feedback') return findNegativeFeedbackMatches(text).length > 0;
    if (metricKey === 'positive_feedback') return findPositiveFeedbackMatches(text).length > 0;
    if (metricKey === 'hard_rule') return hasUserHardRuleText(text);
    if (metricKey === 'user_goal_shift') return hasUserGoalShiftSignal(text);
    if (metricKey === 'result_artifact') return isAssistantCompletionResultSignal(event) || isAssistantDeliverableArtifactSignal(event);
    if (metricKey === 'completion_result') return isAssistantCompletionResultSignal(event);
    if (metricKey === 'deliverable_artifact') return isAssistantDeliverableArtifactSignal(event);
    if (metricKey === 'progress_update') return isAssistantProgressUpdateSignal(event);
    if (metricKey === 'self_correction') return hasSelfCorrectionSignal(event);
    if (metricKey === 'repeated_execution') return hasRepeatedExecutionSignal(event);
    return false;
  };
  const metricAnnotationTarget = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, metricScopeId?: string): string =>
    observationMetricAnnotationTargetId({ ...event, metricScopeId }, metricKey);
  const metricAnnotationVerdict = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, metricScopeId?: string): 'confirmed' | 'rejected' | '' => {
	    const entry = observationMetricAnnotationEntry(
	      reviewState,
	      { ...event, metricScopeId },
	      metricKey,
	    );
	    return entry?.verdict === 'confirmed' || entry?.verdict === 'rejected' ? entry.verdict : '';
	  };
  const metricAnnotationReason = (event: ExperienceTimelineEvent, metricKey: ObservationMetricKey, metricScopeId?: string): string => {
	    const entry = observationMetricAnnotationEntry(
	      reviewState,
	      { ...event, metricScopeId },
	      metricKey,
	    );
	    return typeof entry?.reason === 'string' ? entry.reason : '';
	  };
  const timelineManualMetricKeys = (): ObservationMetricKey[] => [
    'user_correction',
    'user_interruption',
    'user_follow_up',
    'negative_feedback',
    'positive_feedback',
    'hard_rule',
    'user_goal_shift',
    'completion_result',
    'deliverable_artifact',
    'progress_update',
    'self_correction',
    'repeated_execution',
  ];
  const renderTimelineManualMarkButton = (sessionId: string, event: ExperienceTimelineEvent, userIndex: number, allowMetrics: boolean): string => {
	    const metrics = allowMetrics ? timelineManualMetricKeys().map((metricKey) => {
	      const targetId = metricAnnotationTarget(event, metricKey, sessionId);
	      const verdict = metricAnnotationVerdict(event, metricKey, sessionId);
	      const reason = metricAnnotationReason(event, metricKey, sessionId);
	      const ruleDetected = evidenceMetricRuleDetected(event, userIndex, metricKey);
	      const label = evidenceMetricLabels[metricKey];
	      return { targetId, metricKey, metricScopeId: sessionId, verdict, reason, ruleDetected, label };
	    }) : [];
    const goalTargetId = `${sessionId}:${event.messageIndex ?? event.id}`;
    const goalAction = goalSliceCorrectionAction(sessionId, event);
    const activeCount = metrics.filter((m) => m.verdict === 'confirmed' || m.verdict === 'rejected').length + (goalAction ? 1 : 0);
    const mode = allowMetrics ? 'metrics' : 'window_only';
    const buttonLabel = allowMetrics
      ? `人工标记${activeCount > 0 ? `(${activeCount})` : ''}`
      : goalAction === 'add_to_current_skill_window'
        ? '已加入窗口'
        : '加入窗口';
    const source = {
      traceId: event.traceId,
      sourceTrace: event.sourceTrace,
      sessionId: event.sessionId,
      messageIndex: event.messageIndex,
      messageUuid: event.messageUuid,
      callInstanceId: event.callInstanceId,
      toolUseId: event.toolUseId,
      snippet: (event.snippet ?? '').slice(0, 240),
    };
    return `<button type="button"
      class="timeline-manual-mark-button ${activeCount > 0 ? 'is-marked' : ''} ${allowMetrics ? '' : 'is-window-only'}"
      data-manual-mark-mode="${mode}"
      data-manual-mark-session-id="${e(sessionId)}"
      data-manual-mark-goal-target="${e(goalTargetId)}"
      data-manual-mark-goal-action="${e(goalAction)}"
      data-manual-mark-metrics="${e(JSON.stringify(metrics))}"
      data-manual-mark-source="${e(JSON.stringify(source))}"
      data-trace-id="${e(event.traceId ?? '')}"
      data-source-trace="${e(event.sourceTrace)}"
      data-session-id="${e(event.sessionId)}"
      data-message-index="${event.messageIndex ?? ''}"
      data-message-uuid="${e(event.messageUuid ?? '')}"
      data-call-instance-id="${e(event.callInstanceId ?? '')}"
      data-tool-use-id="${e(event.toolUseId ?? '')}"
      data-snippet="${e((event.snippet ?? '').slice(0, 240))}"
      onclick="openTimelineManualMark(this)"
      title="${allowMetrics ? '人工标记这条消息' : '这条消息不在当前 skill 窗口内，先加入窗口后才能标注指标'}">${buttonLabel}</button>`;
  };
  const goalSliceCorrectionAction = (sessionId: string, event: ExperienceTimelineEvent): 'split_goal_slice' | 'add_to_current_skill_window' | '' => {
    const targetId = `${sessionId}:${event.messageIndex ?? event.id}`;
    const key = reviewStateKey('goal_slice_correction', targetId);
    const note = reviewState.entries[key]?.note ?? '';
    if (note.includes('add_to_current_skill_window')) return 'add_to_current_skill_window';
    if (reviewState.entries[key]) return 'split_goal_slice';
    return '';
  };
  const renderExperienceTimeline = (events: ExperienceTimelineEvent[], sessionId: string, options: TimelineRenderOptions = {}): string => {
    if (events.length === 0) return '<div style="color:var(--text-muted);font-size:12px">没有可展示的时间线片段。</div>';
    const reviewSessionId = options.reviewSessionId ?? sessionId;
    const isInsideSkillWindow = (event: ExperienceTimelineEvent): boolean => {
      if (options.activeEventIds) return options.activeEventIds.has(event.id);
      return true;
    };
    const isAddedToSkillWindow = (event: ExperienceTimelineEvent): boolean =>
      goalSliceCorrectionAction(reviewSessionId, event) === 'add_to_current_skill_window';
    const allowMetricTagsFor = (event: ExperienceTimelineEvent): boolean =>
      !options.suppressMetricTagsOutsideSkillWindow || isInsideSkillWindow(event) || isAddedToSkillWindow(event);
    let userIndex = 0;
    const decorated = events.map((event) => {
      const interactionUser = event.kind === 'user_message' && isUserInteractionMetricText(event.snippet ?? '');
      const nextUserIndex = interactionUser ? userIndex++ : -1;
      return { event, userIndex: nextUserIndex };
    });
    const feedbackSignals = options.feedbackSignals ?? [];
    const groups: Array<{ boundary?: ExperienceTimelineEvent; items: typeof decorated }> = [];
    let current: typeof decorated = [];
    let currentBoundary: ExperienceTimelineEvent | undefined;
    for (const item of decorated) {
      const isManualBoundary = goalSliceCorrectionAction(reviewSessionId, item.event) === 'split_goal_slice';
      if (isManualBoundary && current.length > 0) {
        groups.push({ boundary: currentBoundary, items: current });
        current = [];
      }
      if (isManualBoundary) currentBoundary = item.event;
      current.push(item);
    }
    if (current.length > 0) groups.push({ boundary: currentBoundary, items: current });
    const previousHumanUserFor = (order: number): typeof decorated[number] | undefined => {
      for (let index = decorated.length - 1; index >= 0; index -= 1) {
        const item = decorated[index];
        if (item.event.order < order && item.event.kind === 'user_message') return item;
      }
      return undefined;
    };
    const withLeadUserContext = (items: typeof decorated): typeof decorated => {
      const first = items[0];
      if (!first || first.event.kind === 'user_message') return items;
      const previous = previousHumanUserFor(first.event.order);
      if (!previous || items.some((item) => item.event.id === previous.event.id)) return items;
      return [previous, ...items];
    };
	    const renderRow = ({ event, userIndex: currentUserIndex }: typeof decorated[number]): string => {
      const meta = timelineEventMeta(event);
      const allowMetricTags = allowMetricTagsFor(event);
      const searchTags = timelineSearchTags(event, currentUserIndex, allowMetricTags, reviewSessionId, options.currentSkillName, feedbackSignals, Boolean(options.includeDownstreamFeedback));
	      const badges = timelineMetricBadges(event, currentUserIndex, allowMetricTags, reviewSessionId, options.currentSkillName, feedbackSignals, Boolean(options.includeDownstreamFeedback)).join('');
	      const visibleText = event.snippet ?? '';
	      const fullText = event.fullText ?? visibleText;
      const isRealUserReply = event.kind === 'user_message'
        && isUserInteractionMetricText(visibleText)
        && !isSyntheticUserMessageText(visibleText)
        && !isScheduledTaskPromptText(visibleText);
	      const hasMoreFullText = Boolean(fullText && fullText.trim() !== visibleText.trim());
	      const fullTextAttrs = fullText
	        ? ` data-timeline-fulltext="${e(fullText)}" data-timeline-fulltext-title="${e(meta.label)} #${event.messageIndex ?? '—'}" data-timeline-has-more="${hasMoreFullText ? '1' : '0'}" tabindex="${hasMoreFullText ? '0' : '-1'}"`
	        : '';
	      return `<div class="timeline-row timeline-${meta.tone} ${isRealUserReply ? 'is-real-user-reply' : 'is-runtime-event'}" data-timeline-tags="${e(searchTags.join(' '))}" data-current-skill-window="${allowMetricTags ? '1' : '0'}" data-message-index="${event.messageIndex ?? ''}" data-message-uuid="${e(event.messageUuid ?? '')}" data-source-trace="${e(event.sourceTrace)}">
        <div class="timeline-marker">
          <span class="timeline-icon">${e(meta.icon)}</span>
          <span class="timeline-index" title="messageIndex 是各自 jsonl 文件内的索引，跨链路不可直接比较">${event.traceRole === 'subagent' ? '[sub] ' : event.traceRole === 'main' ? '[main] ' : ''}#${event.messageIndex ?? '—'}</span>
        </div>
        <article class="timeline-card">
          <header class="timeline-card-header">
            <div style="min-width:0">
              <div class="timeline-title">${e(meta.label)} <span class="timeline-kind">/ ${e(event.kind)}</span></div>
              <div class="timeline-subtitle">${event.traceLabel ? `链路：${e(event.traceLabel)} · ` : ''}${e(event.label || event.role || event.kind)}${event.toolUseId ? ` · ${e(event.toolUseId)}` : ''}${event.timestamp ? ` · ${e(event.timestamp.slice(0, 19).replace('T', ' '))}` : ''}</div>
            </div>
            <div class="timeline-badges">${badges}</div>
            ${renderTimelineManualMarkButton(reviewSessionId, event, currentUserIndex, allowMetricTags)}
          </header>
	          <pre class="timeline-snippet ${event.isError ? 'is-tool-error' : ''}"${fullTextAttrs}>${highlightTimelineSnippet(event, currentUserIndex, allowMetricTags, reviewSessionId)}</pre>
        </article>
      </div>`;
    };
    const renderWindowMarker = (kind: 'start' | 'end'): string => {
      const label = kind === 'start' ? '当前 skill 目标分片开始' : '当前 skill 目标分片结束';
      return `<div class="timeline-window-marker timeline-window-${kind}" data-timeline-window-marker="${kind}">
        <span>${e(label)}</span>
      </div>`;
    };
    const renderRowsWithWindowMarkers = (items: typeof decorated): string => {
      if (!options.showSkillWindowMarkers) {
        return items.map(renderRow).join('');
      }
      let firstInsideIdx = -1;
      let lastInsideIdx = -1;
      for (let i = 0; i < items.length; i += 1) {
        const inside = isInsideSkillWindow(items[i].event) || isAddedToSkillWindow(items[i].event);
        if (inside) {
          if (firstInsideIdx === -1) firstInsideIdx = i;
          lastInsideIdx = i;
        }
      }
      let output = '';
      for (let index = 0; index < items.length; index += 1) {
        if (index === firstInsideIdx) output += renderWindowMarker('start');
        output += renderRow(items[index]);
        if (index === lastInsideIdx) output += renderWindowMarker('end');
      }
      return output;
    };
    const tabBaseId = `timeline-tabs-${sessionId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
    return `<div class="timeline-goal-tabs" data-timeline-tabs="${e(tabBaseId)}">
      <div class="timeline-tab-list" role="tablist" aria-label="目标片段">
        ${groups.map((group, index) => {
          const boundary = group.boundary;
          const label = boundary ? `目标片段 ${index + 1} · #${boundary.messageIndex ?? '—'}` : `目标片段 ${index + 1}`;
          return `<button type="button" class="timeline-tab-button ${index === 0 ? 'is-active' : ''}" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}" data-timeline-tab="${e(tabBaseId)}-${index}" onclick="switchTimelineGoalTab('${e(tabBaseId)}', ${index})">${e(label)}</button>`;
        }).join('')}
      </div>
      <div class="timeline-tab-panels">
      ${groups.map((group, index) => {
      const boundary = group.boundary;
      const label = boundary
        ? `人工切片点 #${boundary.messageIndex ?? '—'}`
        : index === 0
          ? '默认起点'
          : '延续片段';
      const groupItems = withLeadUserContext(group.items);
      const firstUser = groupItems.find((item) => item.event.kind === 'user_message')?.event.snippet;
      return `<section class="timeline-tab-panel ${index === 0 ? 'is-active' : ''}" role="tabpanel" data-timeline-panel="${e(tabBaseId)}-${index}">
        <header class="timeline-goal-card-header">
          <strong>目标片段 ${index + 1}</strong>
          <span>${e(label)}</span>
        </header>
        ${firstUser ? `<div class="timeline-goal-summary">${e(firstUser.slice(0, 180))}</div>` : ''}
        <div class="experience-timeline">${renderRowsWithWindowMarkers(groupItems)}</div>
      </section>`;
    }).join('')}
      </div>
    </div>`;
  };
  const renderSessionTimelineTree = (session: ExperienceSessionSummary): string => {
    const sessionInvocationIds = new Set(session.invocationIds);
    const invocationEventIds = (experience?.invocations ?? [])
      .filter((invocation) => sessionInvocationIds.has(invocation.id))
      .flatMap((invocation) => invocation.timelineEventIds ?? invocation.timeline.map((event) => event.id));
    const activeEventIds = new Set(
      invocationEventIds.length > 0
        ? invocationEventIds
        : session.timelinePreview.map((event) => event.id),
    );
    const fullTimelineOptions: TimelineRenderOptions = {
      reviewSessionId: session.id,
      currentSkillName: session.skillName,
      includeDownstreamFeedback: shouldIncludeDownstreamFeedbackForDisplay(session),
      feedbackSignals: session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [],
      activeEventIds,
      showSkillWindowMarkers: true,
      suppressMetricTagsOutsideSkillWindow: true,
    };
    const tree = session.timelineTree;
    if (!tree || tree.branches.length === 0) {
      return renderExperienceTimeline(session.fullSessionTimeline ?? session.timelinePreview, `${session.id}-full`, fullTimelineOptions);
    }
    const main = tree.main;
    return `<div class="session-timeline-tree">
      <section class="timeline-main-chain">
        <header class="timeline-chain-header">
          <strong>主线 main</strong>
          <span>${main.length > 0 ? `${main.length} 条事件` : '未发现主线 jsonl'}</span>
        </header>
        ${main.length > 0 ? renderExperienceTimeline(main, `${session.id}-main`, fullTimelineOptions) : '<div style="color:var(--text-muted);font-size:12px;padding:10px;border:1px solid var(--border);border-radius:8px">这个 session 只发现 subagents 子链路，未发现可作为主线的 jsonl。</div>'}
      </section>
      <section class="timeline-branch-list">
        <header class="timeline-chain-header">
          <strong>子链路 subagents</strong>
          <span>${tree.branches.length} 条分支；点击展开查看每个子 agent 的完整链路</span>
        </header>
        ${tree.branches.map((branch, index) => {
          const attach = branch.attachTo
            ? `挂载点：主线 #${branch.attachTo.messageIndex ?? '—'}${branch.attachTo.toolUseId ? ` · ${branch.attachTo.toolUseId}` : ''}`
            : '挂载点：未能从主线 Task 调用精确定位';
          return `<details class="timeline-branch" ${index === 0 ? 'open' : ''}>
            <summary>
              <span>${e(branch.label)}</span>
              <small>${e(attach)} · ${branch.events.length} 条事件</small>
            </summary>
            ${renderExperienceTimeline(branch.events, `${session.id}-branch-${index}`, fullTimelineOptions)}
          </details>`;
        }).join('')}
      </section>
    </div>`;
  };
  const recordRangesText = (
    ranges: ExperienceSessionSummary['timelineScope']['sessionRecordRanges'] | undefined,
  ): string => {
    if (!ranges || ranges.length === 0) return '无可定位 record';
    return ranges.map((range) => {
      const label = range.sourceTrace.split(/[\\/]/).pop() || range.traceId;
      return `${label} #${range.startRecordIndex} - #${range.endRecordIndex}（${range.eventCount} 个事件）`;
    }).join('；');
  };
  const renderTimelineScopeNotice = (session: ExperienceSessionSummary): string => {
    const scope = session.timelineScope;
    if (!scope) {
      return `<div class="timeline-scope-notice" data-timeline-scope-notice>
        <div>
          <strong>当前报告缺少完整 session 时间线数据</strong>
          <span>这通常说明 observation JSON 是旧版本生成的，只包含 skill 窗口片段。</span>
          <span>重新执行 observe ingest 后，报告会写入完整 session 时间线、展示范围和截断信息。</span>
        </div>
        <button type="button" disabled title="当前 report JSON 没有 fullSessionTimeline 字段，无法在前端还原完整 session。">需要重新生成报告</button>
      </div>`;
    }
    const truncatedText = scope.truncated ? '当前 Skill 事件窗口不是完整 session 链路' : '当前展示覆盖本次 Skill 事件窗口';
    const omittedText = `规范时间线中，窗口前有 ${scope.omittedBeforeCount} 个事件，窗口后有 ${scope.omittedAfterCount} 个事件`;
    const branchCount = session.timelineTree?.branches.length ?? 0;
    const chainText = branchCount > 0
      ? `链路结构：主线 main + ${branchCount} 条 subagent 子链路；record 编号只在各自物理 trace 内有效。`
      : '链路结构：单物理 trace 时间线。';
    return `<div class="timeline-scope-notice" data-timeline-scope-notice>
      <div>
        <strong>${e(truncatedText)}</strong>
        <span>当前预览：${scope.previewEventCount} 条 / Skill 事件窗口 ${scope.segmentEventCount ?? scope.previewEventCount} 条 / 完整 session ${scope.fullSessionEventCount} 条</span>
        <span>${e(omittedText)}</span>
        <span>Skill record 范围：${e(recordRangesText(scope.segmentRecordRanges))}</span>
        <span>完整 session record 范围：${e(recordRangesText(scope.sessionRecordRanges))}</span>
        <span>${e(chainText)}</span>
      </div>
      <button type="button" data-full-session-toggle onclick="toggleFullSessionTimeline(this)">查看完整 session 时间线</button>
    </div>`;
  };
  const timelinePreviewWithDisplayFeedback = (session: ExperienceSessionSummary): ExperienceTimelineEvent[] => {
    const preview = session.timelinePreview ?? [];
    const full = session.fullSessionTimeline ?? [];
    if (full.length === 0) return preview;
    const feedbackSignals = canonicalFeedbackSignalsForDisplay(session);
    if (feedbackSignals.length === 0) return preview;
    const alreadyShown = new Set(preview.map((event) => event.id));
    const events = [...preview];
    for (const signal of feedbackSignals) {
      const event = full.find((candidate) => feedbackSignalMatchesEvent(signal, candidate));
      if (!event || alreadyShown.has(event.id)) continue;
      alreadyShown.add(event.id);
      events.push(event);
    }
    return events.sort((a, b) => {
      const time = String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? ''));
      if (time !== 0) return time;
      return a.order - b.order;
    });
  };
  const renderTimelinePair = (session: ExperienceSessionSummary): string => `
    <div class="experience-detail-right timeline-pair-wrap" data-timeline-pair>
      ${renderTimelineScopeNotice(session)}
      <div class="timeline-filter-toolbar" data-timeline-filter-toolbar>
        <label>搜索标签</label>
        <select data-timeline-tag-filter onchange="filterTimelineByTag(this)">
          <option value="">全部标签</option>
          <option value="completion">有结果 / 完成态</option>
          <option value="positive_feedback">用户正向反馈</option>
          <option value="negative_feedback">用户负向反馈</option>
          <option value="user_correction">用户纠正</option>
          <option value="user_follow_up">追问 / 补充</option>
          <option value="user_interruption">人工中断</option>
          <option value="user_goal_shift">目标切换</option>
          <option value="hard_rule">用户硬性要求</option>
          <option value="self_correction">自我纠正</option>
          <option value="repeated_execution">重复执行</option>
          <option value="tool_failure">工具执行失败</option>
          <option value="hedging">不确定表达</option>
          <option value="explicit_marker">显式缺口</option>
        </select>
        <span data-timeline-filter-count>选择标签后，只显示当前回溯里的命中事件。</span>
      </div>
      <div data-timeline-view="segment">${renderExperienceTimeline(timelinePreviewWithDisplayFeedback(session), session.id, {
        reviewSessionId: session.id,
        currentSkillName: session.skillName,
        includeDownstreamFeedback: shouldIncludeDownstreamFeedbackForDisplay(session),
        feedbackSignals: session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [],
      })}</div>
      <div data-timeline-view="full-session" style="display:none">${renderSessionTimelineTree(session)}</div>
    </div>
  `;

  return {
    renderTimelinePair,
  };
}
