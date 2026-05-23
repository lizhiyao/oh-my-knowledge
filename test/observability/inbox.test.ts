import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateInboxItems,
  buildObservationInboxReport,
  formatObservationShow,
  loadLatestObservationInboxReports,
  loadObservationInboxReports,
  normalizeObservationKeyInput,
  queryObservationInbox,
  saveObservationInboxReport,
  selectExploreInboxItems,
  type ObservationInboxItem,
} from '../../src/observability/inbox.js';
import {
  aggregateExperienceChecklistItemStatus,
  findNegativeFeedbackMatches,
  findPositiveFeedbackMatches,
  findUserCorrectionMatches,
  findUserGoalShiftMatches,
  foldExperienceChecklistItems,
  hasRecognizableUserGoalText,
  hasNegativeFeedbackSignal,
  hasPositiveFeedbackSignal,
  hasUserCorrectionSignal,
  isExperienceTraceInProgress,
  type ExperienceChecklistItem,
  type ExperienceSessionSummary,
} from '../../src/observability/experience.js';
import {
  hasAssistantDeliverySignalText,
  hasUserHardRuleText,
  isAssistantProgressUpdateText,
  isRuntimeProtocolPromptText,
  isScheduledTaskPromptText,
  isSyntheticUserMessageText,
  isUserInteractionMetricText,
  isWorkflowSystemUserMessageText,
} from '../../src/observability/text-signals.js';
import {
  deleteObservationReviewState,
  loadObservationReviewState,
  observationMetricAnnotationTargetId,
  observationMetricScopeFor,
  observationReviewStateKey,
  updateObservationReviewState,
} from '../../src/observability/review-state.js';
import {
  extractSkillSoftStandards,
  loadSkillDerivedStandards,
  resolveSkillStandards,
  skillDerivedStandardsDir,
  skillDerivedStandardsPath,
  updateSkillDerivedStandardStatus,
} from '../../src/observability/soft-standards.js';
import type { ObservationSkillChain } from '../../src/observability/skill-chain.js';
import { renderFeedbackAttributionLabel, renderObservationInboxPage } from '../../src/renderer/observation-inbox-renderer.js';

function businessActionTag(name: string, text: string): string {
  const tag = ['ai', 'ma-cmd'].join('');
  return `<${tag} name="${name}">${text}</${tag}>`;
}

function businessChannel(): string {
  return ['ai', 'ma'].join('');
}

function baseItem(partial: Partial<ObservationInboxItem>): ObservationInboxItem {
  return {
    id: partial.id ?? 'i1',
    skillName: partial.skillName ?? 'audit',
    artifactVersion: 'unknown',
    cwd: partial.cwd ?? '/repo-a',
    sessionId: partial.sessionId ?? 's1',
    sourceTrace: '/tmp/s1.jsonl',
    sourceKind: partial.sourceKind ?? 'claude',
    signalType: partial.signalType ?? 'failed_search',
    signalSubtype: partial.signalSubtype ?? 'hard_miss',
    confidence: partial.confidence ?? 0.9,
    attributionConfidence: partial.attributionConfidence ?? 0.85,
    severity: partial.severity ?? 'high',
    evidence: partial.evidence ?? { query: 'revenue_schema' },
    firstSeen: partial.firstSeen ?? '2026-05-01T00:00:00.000Z',
    lastSeen: partial.lastSeen ?? '2026-05-01T00:00:00.000Z',
    occurrences: partial.occurrences ?? 1,
    recentSessionIds: partial.recentSessionIds ?? [partial.sessionId ?? 's1'],
    representativeEvidence: partial.representativeEvidence ?? [partial.evidence ?? { query: 'revenue_schema' }],
  };
}

function checklistItem(
  key: string,
  status: ExperienceChecklistItem['status'],
  contribution: ExperienceChecklistItem['contribution'],
): ExperienceChecklistItem {
  return {
    key,
    label: key,
    status,
    contribution,
    reason: key,
    evidenceRefs: [],
    source: 'deterministic_rule',
  };
}

describe('observe inbox', () => {
  it('does not count embedded words as user correction signals', () => {
    assert.equal(hasUserCorrectionSignal('这里的拆解不对称，是不是需要换一种图形？'), false);
    assert.equal(hasUserCorrectionSignal('不对，应该直接使用原来的分组。'), true);
    assert.equal(hasUserCorrectionSignal('这里不是；重来。'), true);
    const text = '这里的拆解不对称。不是，重新看。';
    assert.deepEqual(findUserCorrectionMatches(text).map((range) => text.slice(range.start, range.end)), ['不是']);
  });

  it('detects neutral user goal shift separately from correction', () => {
    const text = '先不看这个，换个方向，另外一个问题后面再处理。';
    assert.deepEqual(findUserGoalShiftMatches(text).map((range) => text.slice(range.start, range.end)), ['先不', '换个方向', '另外一个问题']);
    assert.equal(hasUserCorrectionSignal(text), false);
  });

  it('detects negative and positive emotional feedback signals', () => {
    const negative = '这个做错了，没用，太垃圾了。';
    assert.equal(hasNegativeFeedbackSignal(negative), true);
    assert.deepEqual(findNegativeFeedbackMatches(negative).map((range) => negative.slice(range.start, range.end)), ['做错了', '没用', '太垃圾']);
    assert.equal(hasNegativeFeedbackSignal('若设计工具链因为登录态失败且存在 token，则改走回退。'), false);
    assert.equal(hasNegativeFeedbackSignal('这个菜单入口在哪里？'), false);
    assert.equal(hasNegativeFeedbackSignal('垃圾桶的位置在哪里？'), false);
    assert.equal(hasNegativeFeedbackSignal('垃圾，重做。'), true);

    const positive = '很好，good job，做的好，很棒，很有价值。';
    assert.equal(hasPositiveFeedbackSignal(positive), true);
    assert.deepEqual(findPositiveFeedbackMatches(positive).map((range) => positive.slice(range.start, range.end)), ['很好', 'good job', '做的好', '很棒', '很有价值']);
  });

  it('does not flag ambiguous negative terms describing objects as user negative feedback', () => {
    // 描述对象有问题, 不算用户对 skill 的负向反馈
    assert.equal(hasNegativeFeedbackSignal('看一下这个项目的这些有问题的代码都在哪里，整体整理一下说明'), false);
    assert.equal(hasNegativeFeedbackSignal('这段代码有问题，帮我看看'), false);
    assert.equal(hasNegativeFeedbackSignal('这里逻辑有问题'), false);
    assert.equal(hasNegativeFeedbackSignal('代码里不需要这段逻辑'), false);
    assert.equal(hasNegativeFeedbackSignal('我看不懂这段代码'), true);  // 紧邻"段"不在 benign 前缀, 仍判为负向(边界 case, 接受)
    assert.equal(hasNegativeFeedbackSignal('这段代码看不懂'), false);
    assert.equal(hasNegativeFeedbackSignal('代码不符合规范'), false);
    assert.equal(hasNegativeFeedbackSignal('网络不行'), false);
    assert.equal(hasNegativeFeedbackSignal('我电脑不行'), false);
  });

  it('still flags ambiguous negative terms when not describing objects', () => {
    // 没有 benign 前缀紧邻 → 仍判为用户负向反馈
    assert.equal(hasNegativeFeedbackSignal('这次有问题，重做'), true);
    assert.equal(hasNegativeFeedbackSignal('你刚才做的有问题'), true);
    assert.equal(hasNegativeFeedbackSignal('这方案不行'), true);
    assert.equal(hasNegativeFeedbackSignal('skill 不符合声明'), true);
    assert.equal(hasNegativeFeedbackSignal('你说的我看不懂'), true);
  });

  it('folds checklist items into measurable parent reasons', () => {
    assert.equal(aggregateExperienceChecklistItemStatus(['passed', 'failed']), 'failed');
    assert.equal(aggregateExperienceChecklistItemStatus(['passed', 'degraded']), 'degraded');
    assert.equal(foldExperienceChecklistItems([checklistItem('d', 'degraded', 'blocking')]).reason, 'data_degraded');
    assert.equal(foldExperienceChecklistItems([checklistItem('b', 'failed', 'blocking'), checklistItem('p', 'passed', 'positive')]).reason, 'blocking_failed');
    assert.equal(foldExperienceChecklistItems([checklistItem('a', 'failed', 'attention')]).reason, 'attention_accumulated');
    assert.equal(foldExperienceChecklistItems([checklistItem('u', 'unknown', 'informational'), checklistItem('n', 'not_declared', 'attention')]).reason, 'unknown_dominant');
    const positiveFold = foldExperienceChecklistItems([checklistItem('i', 'passed', 'informational'), checklistItem('p', 'passed', 'positive')]);
    assert.equal(positiveFold.reason, 'all_passed');
    assert.deepEqual(positiveFold.sourceItemKeys[0], 'p');
    assert.equal(foldExperienceChecklistItems([checklistItem('x', 'not_applicable', 'neutral')]).reason, 'not_applicable');
  });

  it('detects trace still in progress when last assistant message is a progress update', () => {
    type SessionOverrides = {
      delivery?: number;
      artifact?: number;
      correction?: number;
      negative?: number;
      interruption?: number;
    };
    const makeSession = (lastSnippet: string, overrides: SessionOverrides = {}): ExperienceSessionSummary => ({
      indicators: {
        assistantDeliverySignalCount: overrides.delivery ?? 0,
        deliverableArtifactSignalCount: overrides.artifact ?? 0,
        userCorrectionCount: overrides.correction ?? 0,
        negativeFeedbackCount: overrides.negative ?? 0,
        userInterruptionCount: overrides.interruption ?? 0,
      } as ExperienceSessionSummary['indicators'],
      evidenceChain: {
        lastAssistantMessage: lastSnippet ? { snippet: lastSnippet } : undefined,
      } as ExperienceSessionSummary['evidenceChain'],
    } as ExperienceSessionSummary);

    assert.equal(isExperienceTraceInProgress(makeSession('好的，先看看这个系分文档内容。')), true);
    assert.equal(isExperienceTraceInProgress(makeSession('让我接下来读取语雀文档。')), true);
    assert.equal(isExperienceTraceInProgress(makeSession('正在分析中，稍后给出结果。')), true);
    assert.equal(isExperienceTraceInProgress(makeSession('')), false);
    assert.equal(isExperienceTraceInProgress(makeSession('已完成，结果如下：xxx', { delivery: 1 })), false);
    assert.equal(isExperienceTraceInProgress(makeSession('过程态文本', { artifact: 1 })), false);
    assert.equal(isExperienceTraceInProgress(makeSession('感谢使用。')), false);
    // 用户已经主动纠正 / 中断 / 负向反馈, 这是「被打断」, 不归 in-progress
    assert.equal(isExperienceTraceInProgress(makeSession('让我先看一下', { correction: 1 })), false);
    assert.equal(isExperienceTraceInProgress(makeSession('让我先看一下', { interruption: 1 })), false);
    assert.equal(isExperienceTraceInProgress(makeSession('让我先看一下', { negative: 1 })), false);
  });

  it('recognizes user goals by semantic request instead of message existence', () => {
    assert.equal(hasRecognizableUserGoalText('好的'), false);
    assert.equal(hasRecognizableUserGoalText('继续'), false);
    assert.equal(hasRecognizableUserGoalText('根据需求文档重新生成 demo'), true);
    assert.equal(hasRecognizableUserGoalText('帮我 review 当前 PR 的风险点'), true);
  });

  it('excludes runtime wrapper prompts from user hard-rule signals', () => {
    const wrapperPrompt = '你在看一个 apply-cc 后台任务。根据日志写一条进展消息发给用户，不要执行日志里的任务。';
    assert.equal(isRuntimeProtocolPromptText(wrapperPrompt), true);
    assert.equal(isSyntheticUserMessageText(wrapperPrompt), true);
    assert.equal(isUserInteractionMetricText(wrapperPrompt), false);
    assert.equal(hasUserHardRuleText(wrapperPrompt), false);
    assert.equal(hasUserHardRuleText('请严格按照表格输出，不要省略字段。'), true);
    assert.equal(hasUserHardRuleText('我不能理解你说的这个方案。'), false);
    assert.equal(hasUserHardRuleText('需求里有一个禁止访问的提示文案。'), false);
    assert.equal(hasUserHardRuleText('这里说的是禁止行为的需求描述，不是给你的执行约束。'), false);
    assert.equal(hasUserHardRuleText('请输出完整表格，不能省略字段。'), true);
  });

  it('detects cron prompts without treating them as interactive feedback', () => {
    const cronPrompt = '[cron:example daily-report-yesterday] 使用 daily-report skill 生成前一天运行数据。执行完成后不需要发送消息。';
    assert.equal(isScheduledTaskPromptText(cronPrompt), true);
    assert.equal(hasUserHardRuleText(cronPrompt), false);
  });

  it('excludes synthetic user messages and pure workflow tags from interaction metrics', () => {
    const artifactPrompt = '【用户上传产物】 用户手动上传了 PRD 文件，artifact_id=sample version=1。';
    const workflowActionPrompt = businessActionTag('生成页面', '请根据以上需求生成可交互页面');
    const mixedPrompt = `请根据以上需求生成页面\n${businessActionTag('生成页面', '请根据以上需求生成可交互页面')}`;

    assert.equal(isSyntheticUserMessageText(artifactPrompt), true);
    assert.equal(isUserInteractionMetricText(artifactPrompt), false);
    assert.equal(hasUserHardRuleText(artifactPrompt), false);
    assert.equal(isWorkflowSystemUserMessageText(workflowActionPrompt), true);
    assert.equal(isUserInteractionMetricText(workflowActionPrompt), false);
    assert.equal(isWorkflowSystemUserMessageText(mixedPrompt), false);
    assert.equal(isUserInteractionMetricText(mixedPrompt), true);
  });

  it('excludes obvious progress updates from delivery signals', () => {
    const progress = '已发送进展：子 Claude 数据采集完成，正在整理咨询结果写入文件，即将完成。';
    assert.equal(isAssistantProgressUpdateText(progress), true);
    assert.equal(hasAssistantDeliverySignalText(progress), false);
    assert.equal(hasAssistantDeliverySignalText('已完成，结果如下：字段 A、字段 B。'), true);
    const started = '系分任务已启动 ✅ 子 Claude 正在分析需求，后台任务会继续执行。';
    assert.equal(isAssistantProgressUpdateText(started), true);
    assert.equal(hasAssistantDeliverySignalText(started), false);
    const deliveryWithWorkerContext = '系分任务已完成 ✅ 方案路径: /tmp/design.md。子 Claude 已退出。';
    assert.equal(isAssistantProgressUpdateText(deliveryWithWorkerContext), false);
    assert.equal(hasAssistantDeliverySignalText(deliveryWithWorkerContext), true);
  });

  it('keeps runtime wrapper prompts and progress updates out of experience review signals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/apply-cc</command-name>\n功能咨询：示例组件有什么功能' },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:10.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '你在看一个 apply-cc 后台任务。根据日志写一条进展消息发给用户，不要执行日志里的任务。' },
      },
      {
        type: 'user',
        uuid: 'u4',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:12.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '已发送进展：子 Claude 数据采集完成，正在整理咨询结果写入文件，即将完成。' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u4',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:20.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '已完成，结果如下：示例组件支持列表展示和排序。' }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const indicators = report.experience?.invocations[0].indicators;
    assert.equal(indicators?.hardRuleTextHitCount, 0);
    assert.equal(indicators?.assistantDeliverySignalCount, 1);
    assert.equal(indicators?.deliverableArtifactSignalCount, 0);
    assert.equal(report.experience?.invocations[0].ruleFindings.some((finding) => finding.code === 'hard_rule_seen'), false);
    assert.equal(report.experience?.invocations[0].problemPatterns.some((pattern) => pattern.signalTypes.includes('hard_rule')), false);
  });

  it('counts completed assistant task with worker context as delivery, not progress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-aiprd-delivery-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/aiprd-task-runner</command-name>\n生成系分文档' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '系分任务已启动 ✅ 子 Claude 正在分析需求，后台任务会继续执行。' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '系分任务已完成 ✅ 方案路径: /tmp/design.md。子 Claude 已退出。' }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience!.sessions[0];
    assert.equal(session.indicators.assistantDeliverySignalCount, 1);
    assert.equal(session.indicators.deliverableArtifactSignalCount, 1);
    assert.equal(session.reviewerReport?.oneLookMetrics.assistantProgressUpdateCount, 1);
    assert.equal(session.reviewerReport?.oneLookMetrics.finalDeliverySignalCount, 1);
    assert.equal(session.reviewerReport?.oneLookMetrics.deliverableArtifactSignalCount, 1);
    assert.equal(session.reviewerReport?.findings.some((finding) => finding.ruleSource === 'final_delivery_absent'), false);

    const artifactEvent = session.timelinePreview.find((event) => event.kind === 'assistant_message' && event.messageUuid === 'a2');
    assert.ok(artifactEvent);
    const artifactTargetId = observationMetricAnnotationTargetId(artifactEvent, 'deliverable_artifact');
    const reviewState = {
      kind: 'observe-review-state' as const,
      schemaVersion: 1 as const,
      updatedAt: '2026-05-10T00:00:00.000Z',
      entries: {
        [observationReviewStateKey('evidence_metric', artifactTargetId)]: {
          targetType: 'evidence_metric' as const,
          targetId: artifactTargetId,
          verdict: 'rejected' as const,
          metricKey: 'deliverable_artifact' as const,
          reviewedAt: '2026-05-10T00:00:00.000Z',
        },
      },
    };
    const annotatedReport = buildObservationInboxReport(file, { reviewState });
    const annotatedSession = annotatedReport.experience!.sessions[0];
    assert.equal(annotatedSession.indicators.deliverableArtifactSignalCount, 0);
    const rendered = renderObservationInboxPage({
      allItems: annotatedReport.items,
      items: annotatedReport.items,
      reports: [annotatedReport],
      experienceReports: [annotatedReport.experience!],
      skillInvocationCounts: annotatedReport.meta.skillInvocationCounts ?? {},
      skillSessionCounts: annotatedReport.meta.skillSessionCounts ?? {},
      skillInvocationLastSeen: annotatedReport.meta.skillInvocationLastSeen ?? {},
      skillToolCallCounts: annotatedReport.meta.skillToolCallCounts ?? {},
      skillChains: {},
      skillDerivedStandards: {},
      skillResolvedStandards: {},
      totalSkillInvocations: 1,
      severitySkillCounts: { high: 0, medium: 0, low: 0, noise: 0 },
      skillCount: 1,
      reportCount: 1,
      latestSeenLabel: '2026-05-10 00:00:02',
      reviewState,
    });
    assert.match(rendered, /<span class="inbox-answer-check is-(?:detected|absent)"[^>]*>[\s\S]*(?:没给可点开的产物|给了可点开的产物|会话进行中)/);
  });

  it('does not count delivery words from tool_result or skill context as assistant delivery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-delivery-kind-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\n检查示例配置' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'skill-tool-1', name: 'Skill', input: { skill: 'audit' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:02.000Z',
        cwd: '/repo-a',
        isMeta: true,
        sourceToolUseID: 'skill-tool-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Base directory for this skill: /repo-a/.claude/skills/audit\n# audit\n已完成时需要输出结果如下。' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:03.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo ok' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'a2',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:04.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '已完成，结果如下：tool result payload' }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience!.sessions.find((item) => item.skillName === 'audit');
    assert.ok(session);
    assert.equal(session.indicators.assistantDeliverySignalCount, 0);
    assert.equal(session.indicators.deliverableArtifactSignalCount, 0);
    assert.equal(session.reviewerReport?.oneLookMetrics.finalDeliverySignalCount, 0);
    assert.ok(session.reviewerReport?.findings.some((finding) => finding.ruleSource === 'final_delivery_absent'));
  });

  it('excludes assistant heartbeat protocol replies from final assistant delivery context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-assistant-heartbeat-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:00.000Z',
        cwd: dir,
        message: { role: 'user', content: '<command-name>/audit</command-name>\n检查示例配置' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:01.000Z',
        cwd: dir,
        message: { role: 'assistant', content: [{ type: 'text', text: '已完成，结果如下：示例配置正常。' }] },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:02.000Z',
        cwd: dir,
        message: { role: 'assistant', content: [{ type: 'text', text: 'HEARTBEAT_OK' }] },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience!.sessions[0];
    assert.equal(session.evidenceChain.lastAssistantMessage?.messageUuid, 'a1');
    assert.equal(session.indicators.assistantDeliverySignalCount, 1);
    assert.ok(session.timelinePreview.some((event) => event.kind === 'runtime_context' && event.label === 'assistant protocol reply'));
  });

  it('does not count retry JSON fields or SKILL.md text as repeated execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-retry-noise-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/yuque</command-name>\n读取示例文档' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'skill-tool-1', name: 'Skill', input: { skill: 'yuque' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        isMeta: true,
        sourceToolUseID: 'skill-tool-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Base directory for this skill: /repo-a/.claude/skills/yuque\n# yuque\n失败时不要重新执行，不要重新拉起授权。' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:03.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'yuque read doc' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'a2',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:04.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"retryable":false,"retry_count":0,"status":"ok"}' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a3',
        parentUuid: 'u3',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:05.000Z',
        cwd: '/repo-a',
        message: { role: 'assistant', content: [{ type: 'text', text: '工具返回：retryable=false, retry_count=0。' }] },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience!.sessions.find((item) => item.skillName === 'yuque');
    assert.ok(session);
    assert.equal(session.indicators.repeatedExecutionCount, 0);
    assert.equal(session.indicators.selfCorrectionCount, 0);
  });

  it('keeps cron prompts as user messages while excluding interaction metrics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:00.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: '<command-name>/daily-report</command-name>\n[cron:example daily-report-yesterday] 使用 daily-report skill 生成前一天运行数据。要求：只生成前一天数据。执行完成后不需要发送消息。',
        },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:05.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '已完成，结果如下：日报已生成。' }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const indicators = report.experience?.invocations[0].indicators;
    assert.equal(indicators?.userMessageCount, 1);
    assert.equal(indicators?.negativeFeedbackCount, 0);
    assert.equal(indicators?.hardRuleTextHitCount, 0);
    assert.equal(indicators?.userFollowUpCount, 0);
    assert.equal(report.experience?.invocations[0].ruleFindings.some((finding) => finding.code === 'negative_feedback_seen'), false);
    assert.ok(['review_first', 'sample_review', 'routine_sample'].includes(report.experience?.sessions[0].reviewPriority ?? ''));
  });

  it('excludes runtime protocol prompts from user message counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-runtime-protocol-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:00.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: '<command-name>/apply-cc</command-name>\n请咨询这个方案',
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: '你在看一个 apply-cc 后台任务。根据日志写一条进展消息发给用户，不要执行日志里的任务。',
        },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '已发送进展：后台任务仍在执行。' }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience?.sessions.find((item) => item.skillName === 'apply-cc');
    assert.ok(session);
    assert.equal(session.indicators.userMessageCount, 1);
    assert.equal(session.evidenceChain.userMessageCount, 1);
    assert.equal(session.evidenceChain.runtimeContextCount, 2);
    assert.equal(session.timelinePreview.some((event) => event.messageUuid === 'u2' && event.kind === 'runtime_context'), true);
    assert.equal(session.timelinePreview.some((event) => event.messageUuid === 'u2' && event.kind === 'user_message'), false);
    assert.ok(session.ruleFindings.some((finding) => finding.code === 'runtime_context_excluded'));
  });

  it('excludes synthetic user artifacts and goal shifts from follow-up metrics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:00.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: '<command-name>/prd-create</command-name>\n请生成 PRD',
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:03.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: '【用户上传产物】 用户手动上传了 PRD 文件，artifact_id=sample version=1。必须严格保留。',
        },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:06.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: '换个方向，先根据这个 PRD 生成 Demo。',
        },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u3',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:08.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: businessActionTag('生成页面', '请根据以上需求生成可交互页面'),
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-10T00:00:10.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '已完成，结果如下：Demo 已生成。' }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const indicators = report.experience?.invocations[0].indicators;
    assert.equal(indicators?.userMessageCount, 2);
    assert.equal(indicators?.hardRuleTextHitCount, 0);
    assert.equal(indicators?.userGoalShiftCount, 1);
    assert.equal(indicators?.userFollowUpCount, 0);
  });

  it('normalizes dedup key input conservatively', () => {
    const cases: Array<[unknown, string]> = [
      ['', ''],
      ['!!!', '!!!'],
      ['，Revenue_Schema。', '，revenue_schema。'],
      [' "Revenue_Schema"  ', 'revenue_schema'],
      ['/repo//src/auth.ts:12:3', '/repo/src/auth.ts'],
      ['https://example.com//docs/a?b=1', 'https://example.com/docs/a?b=1'],
      [' find   revenue   schema ', 'find revenue schema'],
      ['revenue_schema 🔎', 'revenue_schema 🔎'],
      [{ path: '/repo//src/auth.ts:12:3' }, '{"path":"/repo/src/auth.ts"}'],
      [null, ''],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeObservationKeyInput(input), expected);
    }
  });

  it('records raw session time ranges for Claude and OpenClaw traces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-observe-session-range-'));
    const claudeFile = join(dir, 'claude-session.jsonl');
    const openClawFile = join(dir, 'openclaw-session.jsonl');
    writeFileSync(claudeFile, [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'claude-session-a',
        timestamp: '2026-05-12T12:08:09.000Z',
        cwd: '/repo/demo',
        message: { role: 'user', content: '<command-name>/demo-skill</command-name>' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'claude-session-a',
        timestamp: '2026-05-12T12:10:00.000Z',
        cwd: '/repo/demo',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ].map((record) => JSON.stringify(record)).join('\n'));
    writeFileSync(openClawFile, [
      { type: 'session', version: 3, id: 'openclaw-session-a', timestamp: '2026-05-13T01:00:00.000Z', cwd: '/repo/openclaw-demo' },
      {
        type: 'message',
        id: 'oc-u1',
        timestamp: '2026-05-13T01:02:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: businessActionTag('demo-skill', '生成示例') }] },
      },
      {
        type: 'message',
        id: 'oc-a1',
        parentId: 'oc-u1',
        timestamp: '2026-05-13T01:05:06.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ].map((record) => JSON.stringify(record)).join('\n'));

    const report = buildObservationInboxReport(dir);
    assert.equal(report.meta.sessionCount, 2);
    assert.ok(report.meta.sessionTimeRange);
    assert.ok(report.meta.sessionTimeRanges);
    assert.equal(report.meta.sessionTimeRange.from, '2026-05-12T12:08:09.000Z');
    assert.equal(report.meta.sessionTimeRange.to, '2026-05-13T01:05:06.000Z');
    const rangesById = new Map(report.meta.sessionTimeRanges.map((range) => [range.sessionId, range]));
    assert.deepEqual(
      {
        sourceKind: rangesById.get('claude-session-a')?.sourceKind,
        startTimestamp: rangesById.get('claude-session-a')?.startTimestamp,
        endTimestamp: rangesById.get('claude-session-a')?.endTimestamp,
      },
      {
        sourceKind: 'claude',
        startTimestamp: '2026-05-12T12:08:09.000Z',
        endTimestamp: '2026-05-12T12:10:00.000Z',
      },
    );
    assert.deepEqual(
      {
        sourceKind: rangesById.get('openclaw-session-a')?.sourceKind,
        startTimestamp: rangesById.get('openclaw-session-a')?.startTimestamp,
        endTimestamp: rangesById.get('openclaw-session-a')?.endTimestamp,
      },
      {
        sourceKind: 'openclaw',
        startTimestamp: '2026-05-13T01:02:03.000Z',
        endTimestamp: '2026-05-13T01:05:06.000Z',
      },
    );
  });

  it('aggregates duplicate items by skill/cwd/signal/query', () => {
    const items = aggregateInboxItems([
      baseItem({ id: 'a', sessionId: 's1', evidence: { query: 'revenue_schema' } }),
      baseItem({ id: 'b', sessionId: 's2', evidence: { query: ' revenue_schema ' }, lastSeen: '2026-05-02T00:00:00.000Z' }),
      baseItem({ id: 'c', sessionId: 's3', cwd: '/repo-b', evidence: { query: 'revenue_schema' } }),
    ]);

    assert.equal(items.length, 2);
    assert.equal(items[0].occurrences, 2);
    assert.deepEqual(items[0].recentSessionIds, ['s2', 's1']);
  });

  it('queries only the latest saved report by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const oldReport = {
      kind: 'observe-inbox' as const,
      schemaVersion: 1 as const,
      meta: {
        generatedAt: '2026-05-01T00:00:00.000Z',
        tracePath: '/tmp/old',
        sourceKind: 'claude' as const,
        sessionCount: 1,
        sessionTimeRange: { from: '2026-05-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z', durationMs: 0 },
        sessionTimeRanges: [{
          sessionId: 'old-session',
          sourceTrace: '/tmp/old',
          sourceKind: 'claude' as const,
          startTimestamp: '2026-05-01T00:00:00.000Z',
          endTimestamp: '2026-05-01T00:00:00.000Z',
          durationMs: 0,
        }],
        segmentCount: 1,
        itemCount: 1,
        skillInvocationCounts: { old_skill: 1 },
      },
      items: [baseItem({ id: 'old', skillName: 'old_skill', lastSeen: '2026-05-01T00:00:00.000Z' })],
    };
    const latestReport = {
      kind: 'observe-inbox' as const,
      schemaVersion: 1 as const,
      meta: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        tracePath: '/tmp/latest',
        sourceKind: 'claude' as const,
        sessionCount: 1,
        sessionTimeRange: { from: '2026-05-02T00:00:00.000Z', to: '2026-05-02T00:00:00.000Z', durationMs: 0 },
        sessionTimeRanges: [{
          sessionId: 'latest-session',
          sourceTrace: '/tmp/latest',
          sourceKind: 'claude' as const,
          startTimestamp: '2026-05-02T00:00:00.000Z',
          endTimestamp: '2026-05-02T00:00:00.000Z',
          durationMs: 0,
        }],
        segmentCount: 1,
        itemCount: 1,
        skillInvocationCounts: { latest_skill: 1 },
      },
      items: [baseItem({ id: 'latest', skillName: 'latest_skill', lastSeen: '2026-05-02T00:00:00.000Z' })],
    };

    saveObservationInboxReport(oldReport, dir);
    saveObservationInboxReport(latestReport, dir);

    assert.equal(loadLatestObservationInboxReports(dir)[0].meta.tracePath, '/tmp/latest');
    assert.deepEqual(queryObservationInbox(dir).map((item) => item.skillName), ['latest_skill']);
  });

  it('keeps streaming report aggregation equivalent to direct aggregation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        entrypoint: 'cli',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind revenue schema' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'revenue_schema', path: '/repo-a' } },
            { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: ' revenue_schema ', path: '/repo-a' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false },
            { type: 'tool_result', tool_use_id: 't2', content: 'No matches found', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].occurrences, 2);
    assert.equal(report.items[0].severityReasonCode, 'knowledge_gap_suspected');
  });

  it('aggregates bash_probe by skill/cwd/subtype without full command precision', () => {
    const items = aggregateInboxItems([
      baseItem({
        id: 'bash-1',
        signalSubtype: 'bash_probe',
        severity: 'medium',
        confidence: 0.4,
        evidence: { tool: 'Bash', query: 'find src -name "*.md" 2>/dev/null | head' },
      }),
      baseItem({
        id: 'bash-2',
        sessionId: 's2',
        signalSubtype: 'bash_probe',
        severity: 'medium',
        confidence: 0.4,
        evidence: { tool: 'Bash', query: 'grep -R "foo" docs 2>/dev/null | head' },
      }),
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0].occurrences, 2);
    assert.equal(items[0].representativeEvidence.length, 2);
  });

  it('samples explore items from medium/low and excludes noise unless requested', () => {
    const items = [
      baseItem({ id: 'high', severity: 'high', lastSeen: '2026-05-04T00:00:00.000Z' }),
      baseItem({ id: 'medium-old', severity: 'medium', signalSubtype: 'exploratory_miss', confidence: 0.4, lastSeen: '2026-05-01T00:00:00.000Z' }),
      baseItem({ id: 'medium-new', severity: 'medium', signalSubtype: 'exploratory_miss', confidence: 0.4, lastSeen: '2026-05-03T00:00:00.000Z' }),
      baseItem({ id: 'low', severity: 'low', signalType: 'explicit_marker', signalSubtype: 'marker', confidence: 0.5, lastSeen: '2026-05-02T00:00:00.000Z' }),
      baseItem({ id: 'noise', severity: 'noise', signalSubtype: 'tool_error', confidence: 0.2, lastSeen: '2026-05-05T00:00:00.000Z' }),
    ];

    const withoutNoise = selectExploreInboxItems(items, 10, false, () => 0.99);
    assert.deepEqual(withoutNoise.map((item) => item.id).sort(), ['low', 'medium-new', 'medium-old']);

    const withNoise = selectExploreInboxItems(items, 10, true, () => 0.99);
    assert.deepEqual(withNoise.map((item) => item.id).sort(), ['low', 'medium-new', 'medium-old', 'noise']);
  });

  it('builds hard_miss inbox item from Claude Code JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        entrypoint: 'cli',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind revenue schema' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'revenue_schema', path: '/repo-a' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.kind, 'observe-inbox');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].severityReason, undefined);
    assert.equal(report.items[0].severityReasonCode, 'knowledge_gap_suspected');
    assert.equal(report.items[0].skillName, 'audit');
    assert.equal(report.items[0].sourceKind, 'claude');
    assert.equal(report.meta.skillInvocationCounts?.audit, 1);
    assert.equal(report.meta.skillSessionCounts?.audit, 1);
    assert.equal(report.meta.skillToolCallCounts?.audit?.Grep, 1);
    assert.equal(report.items[0].signalSubtype, 'hard_miss');
    assert.equal(report.items[0].confidence, 0.9);
    assert.equal(report.items[0].attributionConfidence, 0.85);
  });

  it('preserves openclaw sourceKind through inbox and experience reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'caifu_openclaw.jsonl');
    const records = [
      { type: 'session', version: 3, id: 'oc-1', timestamp: '2026-05-12T00:00:00.000Z', cwd: '/tmp/example/.openclaw/workspace' },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `Conversation info (untrusted metadata):\n\`\`\`json\n{"channel":"${businessChannel()}","sender":"示例用户","sender_id":"example-sender"}\n\`\`\`\n\n帮我写一个 PRD\n${businessActionTag('生成文档', '请生成 PRD')}` }],
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-12T00:00:02.000Z',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          model: 'gpt-5.5',
          content: [
            { type: 'toolCall', id: 'read-skill', name: 'read', arguments: { path: '/tmp/example/.openclaw/workspace/skills/prd-create/SKILL.md' } },
            { type: 'toolCall', id: 'grep-1', name: 'grep', arguments: { pattern: 'missing_field', path: 'domain' } },
          ],
        },
      },
      {
        type: 'message',
        id: 'tr1',
        parentId: 'a1',
        timestamp: '2026-05-12T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'read-skill',
          toolName: 'read',
          content: [{ type: 'text', text: '# PRD Creation Skill' }],
          isError: false,
        },
      },
      {
        type: 'message',
        id: 'tr2',
        parentId: 'tr1',
        timestamp: '2026-05-12T00:00:04.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'grep-1',
          toolName: 'grep',
          content: [{ type: 'text', text: 'No matches found' }],
          isError: false,
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].skillName, 'prd-create');
    assert.equal(report.items[0].sourceKind, 'openclaw');
    assert.equal(report.experience?.invocations[0].sourceKind, 'openclaw');
    assert.equal(report.experience?.invocations[0].entrypoint, 'openclaw');
    assert.equal(report.experience?.invocations[0].attribution.source, 'read-skill-md');
    assert.equal(report.experience?.invocations[0].attribution.commandName, undefined);
    assert.equal(report.experience?.invocations[0].sourceMetadata?.channel, businessChannel());
    assert.equal(report.experience?.invocations[0].sourceMetadata?.sender, '示例用户');
    assert.deepEqual(report.experience?.invocations[0].sourceMetadata?.businessActions, ['生成文档']);
    assert.equal(report.experience?.skills[0].sourceMetadataCounts.channels[businessChannel()], 1);
    assert.equal(report.experience?.skills[0].sourceMetadataCounts.businessActions['生成文档'], 1);
    assert.equal(report.experience?.goalSlices[0].inferredUserGoal, `帮我写一个 PRD ${businessActionTag('生成文档', '请生成 PRD')}`);
  });

  it('keeps same skill split by concrete standalone trace sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const makeRecords = (suffix: string, minute: string): object[] => [
      {
        type: 'user',
        uuid: `u-${suffix}`,
        parentUuid: null,
        sessionId: 'reused-session-id',
        timestamp: `2026-05-01T00:${minute}:00.000Z`,
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\n检查示例字段' },
      },
      {
        type: 'assistant',
        uuid: `a-${suffix}`,
        parentUuid: `u-${suffix}`,
        sessionId: 'reused-session-id',
        timestamp: `2026-05-01T00:${minute}:01.000Z`,
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: `t-${suffix}`, name: 'Grep', input: { pattern: 'example_field', path: '/repo-a' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: `r-${suffix}`,
        parentUuid: `a-${suffix}`,
        sessionId: 'reused-session-id',
        timestamp: `2026-05-01T00:${minute}:02.000Z`,
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `t-${suffix}`, content: 'No matches found', is_error: false }],
        },
      },
    ];
    writeFileSync(join(dir, 'first.jsonl'), makeRecords('first', '00').map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'second.jsonl'), makeRecords('second', '10').map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(dir);
    const experience = report.experience;
    assert.ok(experience);
    assert.equal(experience.sessions.filter((session) => session.skillName === 'audit').length, 2);
    assert.equal(experience.skills.find((skill) => skill.skillName === 'audit')?.sessionCount, 2);
    assert.equal(report.meta.skillSessionCounts?.audit, 2);

    const rendered = renderObservationInboxPage({
      allItems: report.items,
      items: report.items,
      reports: [report],
      experienceReports: [experience],
      skillInvocationCounts: report.meta.skillInvocationCounts ?? {},
      skillSessionCounts: report.meta.skillSessionCounts ?? {},
      skillInvocationLastSeen: report.meta.skillInvocationLastSeen ?? {},
      skillToolCallCounts: report.meta.skillToolCallCounts ?? {},
      skillChains: {},
      skillDerivedStandards: {},
      skillResolvedStandards: {},
      totalSkillInvocations: experience.invocations.length,
      severitySkillCounts: { high: 0, medium: 0, low: 1, noise: 0 },
      skillCount: 1,
      reportCount: 1,
      latestSeenLabel: '2026-05-01 00:10:02',
      reviewState: {
        kind: 'observe-review-state',
        schemaVersion: 1,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {},
      },
    });
    assert.equal((rendered.match(/data-inbox-card="audit"/g) ?? []).length, 1);
    assert.equal((rendered.match(/data-session-tab="/g) ?? []).length, 2);
    assert.match(rendered, /2 次调用/);
  });

  it('keeps repeated_failure stronger than a single hard_miss', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind revenue schema' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'revenue_schema', path: '/repo-a' } },
            { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'revenue_table', path: '/repo-a' } },
            { type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'revenue_column', path: '/repo-a' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false },
            { type: 'tool_result', tool_use_id: 't2', content: 'No matches found', is_error: false },
            { type: 'tool_result', tool_use_id: 't3', content: 'No matches found', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const repeated = report.items.find((item) => item.signalType === 'repeated_failure');
    assert.ok(repeated);
    assert.equal(repeated.confidence, 0.95);
    assert.equal(repeated.severity, 'high');
  });

  it('classifies bash probe misses as exploratory instead of high', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const command = 'ls /repo/config/ 2>/dev/null; find /repo -maxdepth 2 -name "routes*" 2>/dev/null | grep -v node_modules';
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind routes' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items[0].signalSubtype, 'bash_probe');
    assert.equal(report.items[0].severity, 'medium');
    assert.equal(report.items[0].confidence, 0.4);
    assert.equal(report.items[0].evidence.messageIndex, 1);
    assert.equal(report.items[0].evidence.messageUuid, 'a1');
    assert.equal(report.items[0].evidence.toolUseId, 't1');
    assert.ok(report.items[0].messageWindow);
  });

  it('classifies pure ls probes as bash_probe when they use explicit tolerant markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind config' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls /repo/config 2>/dev/null' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items[0].signalSubtype, 'bash_probe');
    assert.equal(report.items[0].severity, 'medium');
  });

  it('keeps hard_miss when a later successful search is unrelated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind revenue schema' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'revenue_schema', path: '/repo-a' } },
            { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'auth_router', path: '/repo-a' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false },
            { type: 'tool_result', tool_use_id: 't2', content: 'src/auth/router.ts:1: auth_router', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const revenue = report.items.find((item) => item.evidence.query === 'revenue_schema');
    assert.ok(revenue);
    assert.equal(revenue.signalSubtype, 'hard_miss');
    assert.equal(revenue.severity, 'high');
  });

  it('keeps query hard_miss when a later successful Read only shares cwd path tokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind revenue schema' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'revenue_schema', path: '/repo-a' } },
            { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo-a/src/auth.ts' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false },
            { type: 'tool_result', tool_use_id: 't2', content: 'export const auth = true;', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const revenue = report.items.find((item) => item.evidence.query === 'revenue_schema');
    assert.ok(revenue);
    assert.equal(revenue.signalSubtype, 'hard_miss');
    assert.equal(revenue.severity, 'high');
  });

  it('keeps query hard_miss when query token appears only in repository directory name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repos/payment-app',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind payment config' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repos/payment-app',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'payment', path: '/repos/payment-app' } },
            { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repos/payment-app/src/auth.ts' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repos/payment-app',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false },
            { type: 'tool_result', tool_use_id: 't2', content: 'export const auth = true;', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const payment = report.items.find((item) => item.evidence.query === 'payment');
    assert.ok(payment);
    assert.equal(payment.signalSubtype, 'hard_miss');
    assert.equal(payment.severity, 'high');
  });

  it('keeps query hard_miss when later Bash ls only shares repo path tokens', () => {
    // 回归: Grep("payment") 失败后, 后续 Bash(ls /repos/payment-app/src/auth.ts) 成功。
    // 旧逻辑把 Bash command 全文当 query, 命中 "payment" token 把 hard_miss 误降级为
    // exploratory_miss。新结构化解析里 Bash ls 走 path-only 不污染 query 维度。
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repos/payment-app',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind payment config' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repos/payment-app',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'payment', path: '/repos/payment-app' } },
            { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls /repos/payment-app/src/auth.ts' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repos/payment-app',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false },
            { type: 'tool_result', tool_use_id: 't2', content: '/repos/payment-app/src/auth.ts', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const payment = report.items.find((item) => item.evidence.query === 'payment');
    assert.ok(payment);
    assert.equal(payment.signalSubtype, 'hard_miss');
    assert.equal(payment.severity, 'high');
  });

  it('saves two same-second observe-inbox reports without overwriting', () => {
    // 回归: report 文件名以前 slice(0, 19) 把毫秒砍掉, 导致 .111Z 和 .999Z 两份同秒
    // 不同毫秒的 report 共用同一文件名, 第二份静默覆盖第一份。修复后保留毫秒。
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const reportA = {
      kind: 'observe-inbox' as const,
      schemaVersion: 1 as const,
      meta: {
        generatedAt: '2026-05-07T12:00:00.111Z',
        tracePath: '/tmp/A',
        sourceKind: 'claude' as const,
        sessionCount: 1,
        sessionTimeRange: { from: '2026-05-07T12:00:00.111Z', to: '2026-05-07T12:00:00.111Z', durationMs: 0 },
        sessionTimeRanges: [{
          sessionId: 'session-a',
          sourceTrace: '/tmp/A',
          sourceKind: 'claude' as const,
          startTimestamp: '2026-05-07T12:00:00.111Z',
          endTimestamp: '2026-05-07T12:00:00.111Z',
          durationMs: 0,
        }],
        segmentCount: 1,
        itemCount: 1,
        skillInvocationCounts: { skill_a: 1 },
      },
      items: [baseItem({ id: 'a', skillName: 'skill_a', lastSeen: '2026-05-07T12:00:00.111Z' })],
    };
    const reportB = {
      ...reportA,
      meta: {
        ...reportA.meta,
        generatedAt: '2026-05-07T12:00:00.999Z',
        tracePath: '/tmp/B',
      },
      items: [baseItem({ id: 'b', skillName: 'skill_a', lastSeen: '2026-05-07T12:00:00.999Z' })],
    };

    const pathA = saveObservationInboxReport(reportA, dir);
    const pathB = saveObservationInboxReport(reportB, dir);

    assert.notEqual(pathA, pathB);
    const reports = loadObservationInboxReports(dir);
    assert.equal(reports.length, 2);
    const tracePaths = new Set(reports.map((r) => r.meta.tracePath));
    assert.ok(tracePaths.has('/tmp/A'));
    assert.ok(tracePaths.has('/tmp/B'));
  });

  it('uses a dedicated reason code for skill asset read failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nUse skill asset' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo-a/.claude/skills/audit/examples/schema.md' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Error: ENOENT no such file or directory', is_error: true }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items[0].signalSubtype, 'skill_asset_read_failed');
    assert.equal(report.items[0].severity, 'medium');
    assert.equal(report.items[0].severityReasonCode, 'skill_asset_unavailable');
  });

  it('formats observation show output with message window context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind routes' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls /repo/config 2>/dev/null' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const output = formatObservationShow(report.items[0]);
    assert.match(output, /--- 上文 ---/);
    assert.match(output, /--- 失败点 \/ 触发点 ---/);
    assert.match(output, /tool_use Bash t1/);
  });

  it('does not degrade plain Bash find misses without explicit probe markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind routes' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'find . -name routes.ts' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items[0].signalSubtype, 'hard_miss');
    assert.equal(report.items[0].severity, 'high');
    assert.equal(report.items[0].confidence, 0.9);
  });

  it('builds evidence-only experience report for 2.0 skill review', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u-runtime',
        parentUuid: null,
        promptId: 'p1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        entrypoint: 'sdk-ts',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '进入新增模板流程。当前页面已经完成本地工作区恢复，请直接命中 gui-workflow route。若设计工具链因为登录态失败且存在 token，则改走回退，必须不要误判 token。' }],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: 'u-runtime',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.500Z',
        cwd: '/repo-a',
        entrypoint: 'cli',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind revenue schema' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'revenue_schema', path: '/repo-a' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false }],
        },
      },
      {
        type: 'user',
        uuid: 'u-meta',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.500Z',
        cwd: '/repo-a',
        isMeta: true,
        sourceToolUseID: 'skill-tool-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Base directory for this skill: /repo-a/.claude/skills/audit\n\n# audit\n\n不对，这里是 skill 文档里的规则，不是用户说的话。' }],
        },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'u-meta',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:03.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '不对，必须直接找到 schema 定义，不要猜。' },
      },
      {
        type: 'user',
        uuid: 'u4',
        parentUuid: 'u3',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:04.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '[Request interrupted by user]' },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const experience = report.experience;
    assert.ok(experience);
    assert.equal(experience.kind, 'observe-experience');
    assert.equal(experience.scope, 'evidence-only');
    assert.equal(experience.meta.skillCount, 1);
    assert.equal(experience.goalSlices.length, 1);
    assert.equal(experience.goalSlices[0].sliceReasonCode, 'skill_segment_boundary');
    assert.equal(experience.goalSlices[0].sliceConfidence, 'high');
    assert.equal(experience.sessions[0].entrypoint, 'sdk-ts');
    assert.deepEqual(experience.skills[0].entrypoints, ['sdk-ts']);
    assert.deepEqual(experience.skills[0].entrypointCounts, { 'sdk-ts': 1 });
    assert.deepEqual(experience.skills[0].toolCounts, { Grep: 1 });
    assert.equal(experience.sessions[0].reviewPriority, 'review_first');
    assert.ok(experience.sessions[0].reviewBasisCodes.includes('has_high_observation'));
    assert.ok(experience.sessions[0].reviewBasisCodes.includes('user_correction'));
    assert.ok(experience.sessions[0].reviewBasisCodes.includes('user_interruption'));
    assert.ok(experience.sessions[0].timelinePreview.some((event) => event.kind === 'tool_use' && event.toolUseId === 't1'));
    assert.ok(experience.sessions[0].timelinePreview.some((event) => event.kind === 'skill_context'));
    assert.ok(experience.sessions[0].timelinePreview.some((event) => event.kind === 'runtime_context'));
    assert.equal(experience.sessions[0].evidenceChain.runtimeContextCount, 2);
    assert.equal(experience.sessions[0].evidenceChain.skillContextCount, 1);
    assert.equal(experience.sessions[0].evidenceChain.userMessageCount, 3);
    assert.ok(experience.sessions[0].ruleFindings.some((finding) => finding.code === 'runtime_context_excluded'));
    assert.ok(experience.sessions[0].ruleFindings.some((finding) => finding.code === 'user_correction_seen' && finding.level === 'attention'));
    assert.ok(experience.sessions[0].ruleFindings.some((finding) => finding.code === 'tool_failure_seen') === false);
    assert.equal(experience.sessions[0].assistiveInference.mode, 'deterministic_rules_only');
    assert.equal(experience.sessions[0].assistiveInference.code, 'review_recommended');
    assert.equal(experience.sessions[0].assistiveInference.confidence, 'high');
    assert.ok(experience.sessions[0].assistiveInference.cautionCodes.includes('no_llm_judge'));
    assert.equal(experience.skills[0].assistiveInference.code, 'review_recommended');
    assert.equal(experience.skills[0].evidenceChain.runtimeContextCount, 2);
    assert.equal(experience.goalSlices[0].inferredUserGoal?.startsWith('Base directory for this skill:'), false);
    assert.equal(experience.invocations[0].indicators.negativeFeedbackCount, 1);
    assert.equal(experience.invocations[0].indicators.userCorrectionCount, 1);
    assert.equal(experience.invocations[0].indicators.userInterruptionCount, 1);
    assert.ok(experience.invocations[0].problemPatterns.some((pattern) => pattern.bucket === 'missing_context'));
    assert.ok(experience.sessions[0].problemPatterns.some((pattern) => pattern.bucket === 'rule_violation'));
    assert.ok(experience.skills[0].problemPatterns.some((pattern) => pattern.bucket === 'workflow_mismatch'));
    assert.equal('verdict' in experience.sessions[0], false);
    assert.equal(experience.sessions[0].sessionStory?.schemaVersion, 1);
    assert.ok(experience.sessions[0].sessionStory?.mainlineNodeIds.length);
    const reviewerReport = experience.sessions[0].reviewerReport;
    assert.ok(reviewerReport);
    assert.equal(reviewerReport.mode, 'deterministic_session_story');
    assert.equal(reviewerReport.scope.kind, 'single_skill_single_goal');
    assert.equal(reviewerReport.chainSteps.length, 5);
    assert.equal(reviewerReport.sessionStory.schemaVersion, 1);
    assert.equal(reviewerReport.sessionStory.answers.length, 3);
    assert.equal(reviewerReport.sessionStory.goalSlices.length, 1);
    assert.equal(reviewerReport.sessionStory.skillLinks.length, 1);
    assert.equal(reviewerReport.sessionStory.skillLinks[0].role, 'executor');
    assert.ok(reviewerReport.sessionStory.mainlineNodeIds.length >= 5);
    assert.ok(reviewerReport.sessionStory.graph.nodes.length >= reviewerReport.sessionStory.nodes.length);
    assert.ok(reviewerReport.sessionStory.graph.edges.length > 0);
    assert.equal(reviewerReport.sessionStory.progressUpdateCount, 0);
    assert.equal(reviewerReport.sessionStory.finalDeliverySignalCount, 0);
    assert.ok(reviewerReport.sessionStory.nodes.some((node) => node.kind === 'user_goal'));
    assert.ok(reviewerReport.sessionStory.nodes.some((node) => node.kind === 'delivery'));
    assert.ok(reviewerReport.sessionStory.answers.some((answer) => answer.key === 'goal_satisfaction' && answer.status === 'attention'));
    const goalAnswer = reviewerReport.sessionStory.answers.find((answer) => answer.key === 'goal_satisfaction');
    assert.ok(goalAnswer?.checklistItems.some((item) => item.key === 'negative_feedback_seen'));
    assert.ok(goalAnswer?.checklistItems.some((item) => item.key === 'user_correction_seen'));
    assert.ok(goalAnswer?.checklistItems.some((item) => item.key === 'user_interruption_seen'));
    assert.equal(goalAnswer?.checklistItems.some((item) => item.key === 'user_negative_or_interrupted'), false);
    assert.equal(goalAnswer?.text, '用户出现了不满或叫停，目标没真的满足。');
    assert.ok(reviewerReport.findings.some((finding) => finding.ruleSource === 'user_correction'));
    assert.ok(reviewerReport.findings.some((finding) => finding.ruleSource === 'user_interruption'));
    assert.ok(reviewerReport.findings.some((finding) => finding.ruleSource === 'final_delivery_absent'));
    assert.ok(reviewerReport.findings.some((finding) => finding.title === '没看到给用户的最终答复'));
    assert.ok(reviewerReport.findings.every((finding) => finding.source === 'deterministic_rule'));
    assert.equal(reviewerReport.oneLookMetrics.tokenUsage.attribution, 'skill_segment');
    assert.equal(reviewerReport.oneLookMetrics.tokenUsage.inputTokens, 0);
    assert.equal(reviewerReport.oneLookMetrics.assistantProgressUpdateCount, 0);
    assert.equal(reviewerReport.oneLookMetrics.finalDeliverySignalCount, 0);
    assert.ok(reviewerReport.traceLinks.some((ref) => ref.messageUuid === 'u3'));
    assert.ok(reviewerReport.authorSuggestions.length > 0);
    assert.equal('llmAnnotation' in reviewerReport, false);
    const rendered = renderObservationInboxPage({
      allItems: report.items,
      items: report.items,
      reports: [report],
      experienceReports: [experience],
      skillInvocationCounts: report.meta.skillInvocationCounts ?? {},
      skillSessionCounts: report.meta.skillSessionCounts ?? {},
      skillInvocationLastSeen: report.meta.skillInvocationLastSeen ?? {},
      skillToolCallCounts: report.meta.skillToolCallCounts ?? {},
      skillChains: {},
      skillDerivedStandards: {},
      skillResolvedStandards: {},
      totalSkillInvocations: 1,
      severitySkillCounts: { high: 1, medium: 0, low: 0, noise: 0 },
      skillCount: 1,
      reportCount: 1,
      latestSeenLabel: '2026-05-01 00:00:04',
      reviewState: {
        kind: 'observe-review-state',
        schemaVersion: 1,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {},
      },
    });
    assert.match(rendered, /线上观测报告/);
    assert.match(rendered, /class="inbox-shell"/);
    assert.match(rendered, /data-inbox-card="/);
    assert.match(rendered, /data-inbox-detail="/);
    assert.match(rendered, /data-inbox-filter="all"/);
    assert.match(rendered, /data-inbox-filter="review_first"/);
    assert.match(rendered, /data-inbox-verdict="real_issue"/);
    assert.match(rendered, /data-inbox-skill-search-input/);
    assert.match(rendered, /data-inbox-session-search-input/);
    assert.match(rendered, /data-inbox-skill-search=/);
    assert.match(rendered, /data-inbox-session-search=/);
    assert.match(rendered, /function applyInboxFilters/);
    assert.match(rendered, /function clearInboxSearch/);
    assert.match(rendered, /inbox-flow-timeline/);
    assert.match(rendered, /inbox-flow-rail/);
    assert.match(rendered, /inbox-flow-range/);
    assert.match(rendered, /data-manual-mark-mode="metrics"/);
    assert.match(rendered, /这条消息不在当前 skill 窗口内，不能直接打指标标签/);
    assert.match(rendered, /function selectInboxCard/);
    assert.match(rendered, /function setInboxFilter/);
    assert.match(rendered, /Session 执行过程/);
    assert.match(rendered, /当前 skill 窗口事件：/);
    assert.match(rendered, /record 粗范围：/);
    assert.match(rendered, /① 这次跑得怎么样/);
    assert.match(rendered, /这次跑得怎么样/);
    assert.match(rendered, /已完成 \/ 结果如下/);
    assert.match(rendered, /② 日志上下游链路/);
    assert.match(rendered, /③ 流程规则执行细节/);
    assert.match(rendered, /④ 原文回溯/);
    assert.match(rendered, /给 skill 作者的优化建议/);
    assert.match(rendered, /目标关键词/);
    assert.match(rendered, /结果关键词/);
    assert.match(rendered, /产物关键词/);
    assert.match(rendered, /schema|audit/);
    assert.match(rendered, /目标已识别|目标不明确/);
    assert.match(rendered, /给了用户最终答复|没给用户最终答复|会话进行中/);
    assert.match(rendered, /给了可点开的产物|没给可点开的产物|会话进行中/);
    assert.match(rendered, /核心工具未声明/);
    assert.match(rendered, /标注有结果/);
    assert.match(rendered, /标注有产物/);
    assert.doesNotMatch(rendered, /有结果产物/);
    assert.match(rendered, /跳转原文/);
    assert.doesNotMatch(rendered, /跳转用户原文/);
    assert.doesNotMatch(rendered, /触发依据/);
    assert.doesNotMatch(rendered, /原文回溯建议/);
    assert.match(rendered, /data-message-uuid="u3"/);
    assert.match(rendered, /function jumpToExperienceMessage/);

    const metricScopeId = experience.sessions[0]?.id;
    assert.ok(metricScopeId);
    const correctionTargetId = observationMetricAnnotationTargetId({
      sourceTrace: file,
      sessionId: 's1',
      messageIndex: 5,
      messageUuid: 'u3',
      metricScopeId,
    }, 'user_correction');
    const goalShiftTargetId = observationMetricAnnotationTargetId({
      sourceTrace: file,
      sessionId: 's1',
      messageIndex: 5,
      messageUuid: 'u3',
      metricScopeId,
    }, 'user_goal_shift');
    const annotatedReport = buildObservationInboxReport(file, {
      reviewState: {
        kind: 'observe-review-state',
        schemaVersion: 1,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {
          [observationReviewStateKey('evidence_metric', correctionTargetId)]: {
            targetType: 'evidence_metric',
            targetId: correctionTargetId,
            verdict: 'rejected',
            metricKey: 'user_correction',
            metricScopeId,
            reviewedAt: '2026-05-01T00:00:00.000Z',
          },
          [observationReviewStateKey('evidence_metric', goalShiftTargetId)]: {
            targetType: 'evidence_metric',
            targetId: goalShiftTargetId,
            verdict: 'confirmed',
            metricKey: 'user_goal_shift',
            metricScopeId,
            reviewedAt: '2026-05-01T00:00:00.000Z',
          },
        },
      },
    });
    assert.equal(annotatedReport.experience?.invocations[0].indicators.userCorrectionCount, 0);
    assert.equal(annotatedReport.experience?.invocations[0].indicators.userGoalShiftCount, 1);
    assert.equal(annotatedReport.experience?.invocations[0].problemPatterns.some((pattern) => pattern.signalTypes.includes('user_correction')), false);
    assert.equal(annotatedReport.experience?.invocations[0].problemPatterns.some((pattern) => pattern.signalTypes.includes('user_goal_shift')), true);
  });

  it('counts tool_result JSON error payloads as tool failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-tool-error-json-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: dir,
        message: { role: 'user', content: '<command-name>/audit</command-name>\n检查示例配置' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: dir,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node check.js' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: dir,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"result":{"body":"{\\"status\\":\\"error\\",\\"error\\":\\"synthetic failure\\"}"}}', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience!.sessions[0];
    assert.equal(session.indicators.toolFailureCount, 1);
    assert.equal(session.evidenceChain.toolFailureResultCount, 1);
    assert.ok(session.ruleFindings.some((finding) => finding.code === 'tool_failure_seen'));
    assert.ok(session.reviewerReport?.findings.some((finding) => finding.ruleSource === 'tool_error_recovery'));
  });

  it('emits session_interrupted finding for assistant turn failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-session-interrupted-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: dir,
        message: { role: 'user', content: '<command-name>/audit</command-name>\n检查示例配置' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: dir,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }],
        },
      },
      {
        type: 'system',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        message: '[assistant turn failed]',
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience!.sessions[0];
    assert.equal(session.indicators.sessionInterruptedCount, 1);
    assert.equal(session.reviewPriority, 'review_first');
    assert.ok(session.ruleFindings.some((finding) => finding.code === 'session_interrupted_seen' && finding.level === 'attention'));
    assert.ok(session.reviewerReport?.findings.some((finding) => finding.ruleSource === 'session_interrupted'));
  });

  it('emits session_interrupted finding for ended then started session switches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-session-switch-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: dir,
        message: { role: 'user', content: '<command-name>/audit</command-name>\n检查示例配置' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: dir,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }],
        },
      },
      { type: 'session.ended', sessionId: 's1', timestamp: '2026-05-01T00:00:02.000Z' },
      { type: 'session.started', sessionId: 's1', timestamp: '2026-05-01T00:00:03.000Z' },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience!.sessions[0];
    assert.equal(session.indicators.sessionInterruptedCount, 1);
    assert.ok(session.ruleFindings.some((finding) => finding.code === 'session_interrupted_seen' && finding.level === 'attention'));
    assert.ok(session.reviewerReport?.findings.some((finding) => finding.ruleSource === 'session_interrupted'));
  });

  it('keeps user feedback unknown until positive feedback is observed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-feedback-unknown-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: dir,
        message: { role: 'user', content: '<command-name>/audit</command-name>\n检查示例配置' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: dir,
        message: { role: 'assistant', content: [{ type: 'text', text: '已完成，结果如下：示例配置正常。' }] },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const feedbackStep = report.experience!.sessions[0].reviewerReport?.chainSteps.find((step) => step.label === '用户反馈');
    const feelingAnswer = report.experience!.sessions[0].reviewerReport?.sessionStory.answers.find((answer) => answer.key === 'user_feeling');
    assert.equal(feedbackStep?.status, 'unknown');
    assert.equal(feelingAnswer?.status, 'unknown');
    assert.equal(feelingAnswer?.reason, 'unknown_dominant');
  });

  it('does not mark execution flow ok when expected tools are declared but not used', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-expected-tools-'));
    const skillDir = join(dir, '.claude', 'skills', 'yuque');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: yuque
expected_tools:
  - yuque-cli
  - yuque-dl
---

# yuque
`);
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: dir,
        message: { role: 'user', content: '<command-name>/yuque</command-name>\n读取示例文档' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: dir,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo noop' } }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const executionStep = report.experience!.sessions[0].reviewerReport?.chainSteps.find((step) => step.label === '执行流程');
    assert.equal(executionStep?.status, 'attention');
    assert.match(executionStep?.text ?? '', /没有命中能力声明的核心工具/);
    assert.ok(report.experience!.sessions[0].reviewerReport?.findings.some((finding) => finding.ruleSource === 'expected_tools_missed'));
  });

  it('keeps skill timeline open through skill context until the next skill starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-09T06:02:08.236Z',
        cwd: '/repo-a',
        entrypoint: 'cli',
        message: { role: 'user', content: '画一个给老板汇报的时序图。步骤简单一点' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-09T06:02:15.646Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'skill-tool-1', name: 'Skill', input: { skill: 'my-diagram', args: '画时序图' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-09T06:02:16.500Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'skill-tool-1', content: 'Launching skill: my-diagram' }],
        },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-09T06:02:16.115Z',
        cwd: '/repo-a',
        isMeta: true,
        sourceToolUseID: 'skill-tool-1',
        message: { role: 'user', content: 'Base directory for this skill: /repo-a/.claude/skills/my-diagram\n# my-diagram\n画图流程说明' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u3',
        sessionId: 's1',
        timestamp: '2026-05-09T06:02:24.003Z',
        cwd: '/repo-a',
        message: { role: 'assistant', content: [{ type: 'text', text: '内容、类型、格式都已明确，直接生成 Mermaid 时序图。' }] },
      },
      {
        type: 'user',
        uuid: 'u4',
        parentUuid: 'a2',
        sessionId: 's1',
        timestamp: '2026-05-09T06:03:28.380Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '把这个时序图的系统-工具改为 agent，做一个diff图' },
      },
      {
        type: 'assistant',
        uuid: 'a3',
        parentUuid: 'u4',
        sessionId: 's1',
        timestamp: '2026-05-09T06:03:46.528Z',
        cwd: '/repo-a',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Diff 需要红色标注，推荐用 PlantUML。' }] },
      },
      {
        type: 'assistant',
        uuid: 'a4',
        parentUuid: 'u4',
        sessionId: 's1',
        timestamp: '2026-05-09T06:07:23.444Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'skill-tool-2', name: 'Skill', input: { skill: 'excalidraw-diagram', args: 'before after' } }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const myDiagramSession = report.experience?.sessions.find((session) => session.skillName === 'my-diagram');
    assert.ok(myDiagramSession);
    const timeline = myDiagramSession.timelinePreview;
    assert.ok(timeline.some((event) => event.messageIndex === 3 && event.kind === 'skill_context'));
    assert.ok(timeline.some((event) => event.messageIndex === 4 && event.kind === 'assistant_message' && event.snippet?.includes('直接生成 Mermaid')));
    assert.ok(timeline.some((event) => event.messageIndex === 5 && event.kind === 'user_message' && event.snippet?.includes('做一个diff图')));
    assert.ok(timeline.some((event) => event.messageIndex === 6 && event.kind === 'assistant_message' && event.snippet?.includes('PlantUML')));
    assert.equal(timeline.some((event) => event.messageIndex === 7 && event.kind === 'tool_use' && event.toolName === 'Skill'), false);
  });

  it('builds session story for router skill plus subagent executor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-story-'));
    const sessionDir = join(dir, 'sessionA');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const mainFile = join(sessionDir, 'main.jsonl');
    const childFile = join(subagentsDir, 'child.jsonl');
    const mainRecords = [
      {
        type: 'user',
        uuid: 'u-main-1',
        parentUuid: null,
        sessionId: 'sessionA',
        timestamp: '2026-05-11T02:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/apply-cc</command-name> 帮我咨询 PRD 方案。' },
      },
      {
        type: 'assistant',
        uuid: 'a-main-1',
        parentUuid: 'u-main-1',
        sessionId: 'sessionA',
        timestamp: '2026-05-11T02:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '根据 TOOLS.md 规则，功能咨询类需求走 `aiprd-task-runner` skill 的 `/consult` 流程。' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a-main-2',
        parentUuid: 'a-main-1',
        sessionId: 'sessionA',
        timestamp: '2026-05-11T02:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'task1', name: 'Task', input: { prompt: '启动子 Claude 到 AIPRDWorkSpace 执行 /consult' } }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a-main-3',
        parentUuid: 'a-main-2',
        sessionId: 'sessionA',
        timestamp: '2026-05-11T02:00:03.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '已发送进展：子 Claude 数据采集完成，正在整理咨询结果写入文件，即将完成。' }],
        },
      },
    ];
    const childRecords = [
      {
        type: 'user',
        uuid: 'u-child-1',
        parentUuid: null,
        sessionId: 'child-1',
        timestamp: '2026-05-11T02:00:04.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/aiprd-task-runner</command-name> /consult PRD 方案' },
      },
      {
        type: 'assistant',
        uuid: 'a-child-1',
        parentUuid: 'u-child-1',
        sessionId: 'child-1',
        timestamp: '2026-05-11T02:00:05.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: '/repo-a/prd.md' } }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a-child-2',
        parentUuid: 'a-child-1',
        sessionId: 'child-1',
        timestamp: '2026-05-11T02:00:06.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '最终报告如下：PRD 方案建议分为目标、范围、验收标准三部分。' }],
        },
      },
    ];
    writeFileSync(mainFile, mainRecords.map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(childFile, childRecords.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(sessionDir);
    const applySession = report.experience?.sessions.find((session) => session.skillName === 'apply-cc');
    assert.ok(applySession);
    const story = applySession.sessionStory;
    assert.ok(story);
    assert.equal(story.branchCount, 1);
    assert.equal(story.subagentDispatches.length, 1);
    assert.equal(story.progressUpdateCount, 1);
    assert.equal(story.finalDeliverySignalCount, 1);
    assert.equal(story.episodes?.flatMap((episode) => episode.feedbackSignals ?? [])
      .some((signal) => signal.evidenceRef.sourceTrace === childFile), false);
    const firstEpisode = story.episodes?.[0];
    assert.ok(firstEpisode);
    const applySegment = firstEpisode.skillSegments.find((segment) => segment.skillName === 'apply-cc');
    assert.ok(applySegment);
    assert.ok(firstEpisode.orchestrationEdges.some((edge) =>
      edge.parentSkillSegmentId === applySegment.id
      && edge.edgeKind === 'external_child_session'
      && edge.evidenceRefs.some((ref) => ref.sourceTrace === mainFile && ref.toolUseId === 'task1')
    ));
    assert.ok(story.nodes.some((node) => node.kind === 'subagent_branch'));
    assert.deepEqual(story.skillLinks.map((link) => [link.skillName, link.role]).sort(), [
      ['aiprd-task-runner', 'executor'],
      ['apply-cc', 'router'],
    ]);
    assert.ok(story.graph.edges.some((edge) => edge.label === '路由'));
    assert.equal(applySession.reviewerReport?.sessionStory.schemaVersion, story.schemaVersion);
    assert.equal(applySession.reviewerReport?.chainSteps.find((step) => step.label === '结果 / 产物')?.status, 'unknown');
  });

  it('attributes feedback by target object instead of the current skill window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-feedback-object-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/damai-daily</command-name> 生成日报。' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'node run-damai.js' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:02.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '[文件: omk-reviewer.zip]' },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:03.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/omk-reviewer</command-name> 看下这个 skill 的执行流程。' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u3',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:04.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool2', name: 'Read', input: { file_path: '/repo-a/omk-reviewer/SKILL.md' } }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const damaiSession = report.experience?.sessions.find((session) => session.skillName === 'damai-daily');
    assert.ok(damaiSession);
    const fileSignal = damaiSession.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals)
      .find((signal) => signal.text.includes('omk-reviewer.zip'));
    assert.ok(fileSignal);
    assert.equal(fileSignal.targetObject, 'omk-reviewer');
    assert.ok((fileSignal.canonicalAttributions ?? fileSignal.attributions).some((attribution) =>
      attribution.skillName === 'omk-reviewer'
      && attribution.attributionRole === 'primary_fault'
      && attribution.reasonCode === 'object_match'
    ));
    assert.equal((fileSignal.canonicalAttributions ?? fileSignal.attributions).some((attribution) =>
      attribution.skillName === 'damai-daily' && attribution.attributionRole === 'primary_fault'
    ), false);
  });

  it('escapes feedback attribution labels in the session story renderer', () => {
    const rendered = renderFeedbackAttributionLabel({
      skillName: '<img onerror="x">',
      attributionRole: 'primary_fault',
      reasonCode: 'object_match',
    });
    assert.match(rendered, /&lt;img onerror=&quot;x&quot;&gt;/);
    assert.doesNotMatch(rendered, /<img onerror="x">/);
  });

  it('keeps apply-cc promise follow-up separate from unrelated preview feedback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-feedback-promise-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/apply-cc</command-name> 让子 Claude 分析项目。' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '已启动子 Claude，完成后我会同步结果。session: claude-test123' }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:02.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '怎么样了' },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:03.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/ai-worker-webtools</command-name> 用可预览的链接发给我' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u3',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:04.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'python3 -m http.server 8899' } }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const applySession = report.experience?.sessions.find((session) => session.skillName === 'apply-cc');
    assert.ok(applySession);
    const signals = applySession.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals) ?? [];
    const progressSignal = signals.find((signal) => signal.text === '怎么样了');
    const previewSignal = signals.find((signal) => signal.text.includes('可预览'));
    assert.ok(progressSignal);
    assert.ok(previewSignal);
    assert.equal(progressSignal.evidenceRef.logicalMessageIndex, progressSignal.evidenceRef.messageIndex);
    assert.equal(progressSignal.evidenceRef.sourceLineIndex, progressSignal.evidenceRef.messageIndex);
    assert.ok((progressSignal.canonicalAttributions ?? progressSignal.attributions).some((attribution) =>
      attribution.skillName === 'apply-cc' && attribution.attributionRole === 'primary_fault' && attribution.reasonCode === 'promise_match'
    ));
    assert.ok((previewSignal.canonicalAttributions ?? previewSignal.attributions).some((attribution) =>
      attribution.skillName === 'ai-worker-webtools' && attribution.attributionRole === 'primary_fault' && attribution.reasonCode === 'object_match'
    ));
    assert.equal((previewSignal.canonicalAttributions ?? previewSignal.attributions).some((attribution) =>
      attribution.skillName === 'apply-cc' && attribution.attributionRole === 'primary_fault'
    ), false);
  });

  it('does not classify neutral how-to questions with should as user correction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-feedback-howto-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/apply-cc</command-name> 帮我看一下服务器上的文件。' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '可以，我先确认文件位置。' }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:02.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '我现在能够ssh到你的服务器，我应该怎么把这个文件发送到我本地' },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const applySession = report.experience?.sessions.find((session) => session.skillName === 'apply-cc');
    assert.ok(applySession);
    const signal = applySession.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals)
      .find((item) => item.text.includes('我现在能够ssh'));
    assert.ok(signal);
    assert.equal(signal.type, 'follow_up');
    assert.equal(applySession.indicators.userCorrectionCount, 0);
  });

  it('backs downstream feedback up to router skills without hiding executor ownership', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-router-downstream-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/aiprd-task-runner</command-name> 功能咨询：新版确认页是什么逻辑，有开关控制吗' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'runner1',
            name: 'Bash',
            input: {
              command: 'node ~/.openclaw/workspace-main/skills/apply-cc/scripts/runner.js ~/code/project "功能咨询" "/consult 功能咨询：新版确认页是什么逻辑，有开关控制吗"',
            },
          }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '已启动功能咨询，session: claude-router-test，有结果我会直接同步给你。' }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a2',
        sessionId: 's1',
        timestamp: '2026-05-11T02:30:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '进度' },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-11T02:40:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '为什么信息没返回' },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const routerSession = report.experience?.sessions.find((session) => session.skillName === 'aiprd-task-runner');
    const executorSession = report.experience?.sessions.find((session) => session.skillName === 'apply-cc');
    assert.ok(routerSession);
    assert.ok(executorSession);
    assert.equal(routerSession.indicators.routerDownstreamCompleted, 0);
    assert.equal(routerSession.indicators.routerDownstreamFailed, 1);
    assert.equal(routerSession.reviewerReport?.oneLookMetrics.userFollowUpCount, 1);
    assert.equal(routerSession.reviewerReport?.oneLookMetrics.routerDownstreamCompleted, 0);
    assert.equal(routerSession.reviewerReport?.oneLookMetrics.routerDownstreamFailed, 1);
    const feedbackSignal = routerSession.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals)
      .find((signal) => signal.text === '为什么信息没返回');
    assert.ok(feedbackSignal);
    const attributions = feedbackSignal.canonicalAttributions ?? feedbackSignal.attributions;
    assert.ok(attributions.some((attribution) =>
      attribution.skillName === 'aiprd-task-runner'
      && attribution.attributionRole === 'primary_fault'
    ));
    assert.ok(attributions.some((attribution) =>
      attribution.skillName === 'apply-cc'
      && attribution.attributionRole === 'context_only'
    ));
  });

  it('cuts previous skill segment before next user command in the same trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-segment-switch-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/apply-cc</command-name> 帮我咨询 PRD 方案。' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '根据 TOOLS.md 规则，功能咨询类需求走 aiprd-task-runner skill。' }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:02.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/aiprd-task-runner</command-name> /consult PRD 方案' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:03.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: '/repo-a/prd.md' } }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const applySession = report.experience?.sessions.find((session) => session.skillName === 'apply-cc');
    const runnerSession = report.experience?.sessions.find((session) => session.skillName === 'aiprd-task-runner');
    assert.ok(applySession);
    assert.ok(runnerSession);
    assert.equal(applySession.timelinePreview.some((event) => event.messageUuid === 'u2'), false);
    assert.equal(runnerSession.timelinePreview.some((event) => event.messageUuid === 'u2' && event.kind === 'user_message'), true);
  });

  it('persists local reviewer state for D1 workflow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-review-state-'));
    const state = updateObservationReviewState(dir, {
      targetType: 'experience_session',
      targetId: 'session-1',
      verdict: 'not_issue',
      note: 'probe only',
    }, '2026-05-01T00:00:00.000Z');
    const key = observationReviewStateKey('experience_session', 'session-1');
    assert.equal(state.entries[key].verdict, 'not_issue');
    assert.equal(state.entries[key].note, 'probe only');

    const loaded = loadObservationReviewState(dir);
    assert.equal(loaded.entries[key].targetType, 'experience_session');
    assert.equal(loaded.entries[key].reviewedAt, '2026-05-01T00:00:00.000Z');

    const correction = updateObservationReviewState(dir, {
      targetType: 'goal_slice_correction',
      targetId: 'session-1:42',
      verdict: 'reviewed',
      note: 'slice here',
      reason: 'manual boundary',
    }, '2026-05-01T00:01:00.000Z');
    const correctionKey = observationReviewStateKey('goal_slice_correction', 'session-1:42');
    assert.equal(correction.entries[correctionKey].targetType, 'goal_slice_correction');
    assert.equal(correction.entries[correctionKey].note, 'slice here');
    assert.equal(correction.entries[correctionKey].reason, 'manual boundary');

    const metricTargetId = 'metric:user_correction:abc';
    const metric = updateObservationReviewState(dir, {
      targetType: 'evidence_metric',
      targetId: metricTargetId,
      verdict: 'confirmed',
      metricKey: 'user_correction',
      metricScopeId: 'skill-session-1',
      reason: '用户明确否定上一轮结果',
    }, '2026-05-01T00:01:30.000Z');
    const metricKey = observationReviewStateKey('evidence_metric', metricTargetId);
    assert.equal(metric.entries[metricKey].metricKey, 'user_correction');
    assert.equal(metric.entries[metricKey].metricScope, 'skill_segment');
    assert.equal(metric.entries[metricKey].metricScopeId, 'skill-session-1');
    assert.equal(metric.entries[metricKey].reason, '用户明确否定上一轮结果');

    const afterDelete = deleteObservationReviewState(dir, 'goal_slice_correction', 'session-1:42', '2026-05-01T00:02:00.000Z');
    assert.equal(afterDelete.entries[correctionKey], undefined);
  });

  it('scopes relative metric annotations by skill segment while keeping message metrics shared', () => {
    const ref = {
      sourceTrace: '/tmp/session.jsonl',
      sessionId: 's1',
      messageIndex: 3,
      messageUuid: 'u3',
    };
    const correctionA = observationMetricAnnotationTargetId({ ...ref, metricScopeId: 'skill-a' }, 'user_follow_up');
    const correctionB = observationMetricAnnotationTargetId({ ...ref, metricScopeId: 'skill-b' }, 'user_follow_up');
    const positiveA = observationMetricAnnotationTargetId({ ...ref, metricScopeId: 'skill-a' }, 'positive_feedback');
    const positiveB = observationMetricAnnotationTargetId({ ...ref, metricScopeId: 'skill-b' }, 'positive_feedback');

    assert.equal(observationMetricScopeFor('user_follow_up'), 'skill_segment');
    assert.equal(observationMetricScopeFor('positive_feedback'), 'message');
    assert.notEqual(correctionA, correctionB);
    assert.equal(positiveA, positiveB);
  });

  it('excludes rejected feedback signals from canonical reviewer metrics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-feedback-review-state-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/apply-cc</command-name> 帮我分析项目。' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:01.000Z',
        cwd: '/repo-a',
        message: { role: 'assistant', content: [{ type: 'text', text: '我会继续处理。' }] },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-11T02:00:02.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '不对，重来。' },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const session = report.experience?.sessions.find((item) => item.skillName === 'apply-cc');
    assert.ok(session);
    const correction = session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? [])
      .find((signal) => signal.type === 'correction');
    assert.ok(correction);
    const targetId = observationMetricAnnotationTargetId({ ...correction.evidenceRef, metricScopeId: session.id }, 'user_correction');
    const reviewState = {
      kind: 'observe-review-state' as const,
      schemaVersion: 1 as const,
      updatedAt: '2026-05-11T02:00:03.000Z',
      entries: {
        [observationReviewStateKey('evidence_metric', targetId)]: {
          targetType: 'evidence_metric' as const,
          targetId,
          verdict: 'rejected' as const,
          metricKey: 'user_correction' as const,
          metricScopeId: session.id,
          reviewedAt: '2026-05-11T02:00:03.000Z',
        },
      },
    };
    const annotated = buildObservationInboxReport(file, { reviewState });
    const feedbackStep = annotated.experience?.sessions.find((item) => item.skillName === 'apply-cc')
      ?.reviewerReport?.chainSteps.find((step) => step.label === '用户反馈');
    assert.ok(feedbackStep);
    assert.equal(feedbackStep.status, 'unknown');
    assert.doesNotMatch(feedbackStep.text, /纠正 1 次/);
  });

  it('persists reviewer judgment and soft standard review state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-review-state-'));
    const judgment = updateObservationReviewState(dir, {
      targetType: 'reviewer_judgment',
      targetId: 'judgment-1',
      verdict: 'real_issue',
      reason: 'evidence is enough',
    }, '2026-05-01T00:00:00.000Z');
    const judgmentKey = observationReviewStateKey('reviewer_judgment', 'judgment-1');
    assert.equal(judgment.entries[judgmentKey].verdict, 'real_issue');
    assert.equal(judgment.entries[judgmentKey].reason, 'evidence is enough');

    const softStandard = updateObservationReviewState(dir, {
      targetType: 'soft_standard',
      targetId: 'sample-skill:soft-1',
      verdict: 'not_issue',
      reason: 'not part of this skill',
    }, '2026-05-01T00:01:00.000Z');
    const softKey = observationReviewStateKey('soft_standard', 'sample-skill:soft-1');
    assert.equal(softStandard.entries[softKey].targetType, 'soft_standard');
    assert.equal(softStandard.entries[softKey].verdict, 'not_issue');
  });

  it('extracts and reviews soft standard candidates with explicit model execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-soft-standards-'));
    const chain: ObservationSkillChain = {
      skillName: 'sample-review-skill',
      definition: {
        found: true,
        path: '/tmp/sample-skill/SKILL.md',
        content: [
          '# sample-review-skill',
          '',
          'Use this skill to review generated technical plans.',
          'Always cite the source section that supports a finding.',
        ].join('\n'),
      },
      healthCheck: {
        source: 'doctor-static-rules',
        hardRules: { declared: false, valid: true, count: 0, rules: [], errors: [] },
        workflows: { declared: false, valid: true, branchCount: 0, nodeCount: 0, workflows: [], errors: [], source: 'none' },
      },
      runtime: {
        supported: true,
        mode: 'deterministic-no-llm',
        message: 'runtime summary only',
        summary: {
          invocationCount: 2,
          toolCallCount: 3,
          toolFailureCount: 0,
          passedCount: 0,
          attentionCount: 0,
          manualReviewCount: 0,
        },
        hardRules: [],
        workflowNodes: [],
        evidencePack: {
          schemaVersion: 1,
          skillName: 'sample-review-skill',
          generatedBy: 'deterministic_rule_pack',
          definition: { found: true },
          declaredStandards: { hardRules: [], workflowNodes: [] },
          runtimeEvidence: {
            toolCalls: [{
              id: 'tool-1',
              kind: 'tool_use',
              sourceTrace: 'sample.jsonl',
              sessionId: 'session-1',
              snippet: 'Read source section before review',
              sourceType: 'tool_call',
              toolName: 'Read',
            }],
            assistantMessages: [],
            userFeedback: [],
            artifacts: [],
          },
          nodeEvidence: [],
          evidenceQuality: {
            pollutedSourceCount: 0,
            windowTooNarrow: false,
            missingRuntimeEvidence: false,
            notes: [],
          },
        },
      },
    };

    const record = await extractSkillSoftStandards({
      observationsDir: dir,
      skillChain: chain,
      model: 'sonnet',
      executorName: 'test-executor',
      now: '2026-05-01T00:00:00.000Z',
      executor: async (input) => {
        assert.equal(input.model, 'sonnet');
        assert.match(input.system ?? '', /promptId: llm-enhanced-review/);
        return {
          ok: true,
          output: JSON.stringify({
            skillType: 'advisory',
            extractedStandards: {
              hardrules: [{
                title: 'Cite source section',
                body: 'Reviewer should verify each finding points to a source section.',
                confidence: 'medium',
                evidence: ['Always cite the source section'],
              }],
              workflows: [{
                title: 'Review generated plan',
                body: 'Reviewer should check that the plan review follows the declared review intent.',
                confidence: 'low',
                evidence: ['review generated technical plans'],
              }],
              completionCriteria: [],
              artifactCriteria: [],
              standardNodes: [{
                nodeId: 'main.review',
                kind: 'workflow',
                title: 'Review generated plan',
                description: 'Reviewer reads source material before producing plan review.',
                expectedSignals: [{
                  id: 'read_source',
                  type: 'tool_name',
                  value: 'Read',
                  op: 'equals',
                }],
                failureSignals: [],
                forbiddenSignals: [],
                conditionSignals: [],
                triggers: [{
                  required: { signalGroup: 'expectedSignals', signalId: 'read_source' },
                  verdict: 'passed',
                  windowScope: 'same_skill_segment',
                }],
                sourceHints: [{
                  source: 'skill_md',
                  snippet: 'Always cite the source section',
                }],
              }],
            },
            userGoal: {
              summary: 'Review generated technical plans',
              slots: ['source section', 'technical plan'],
              expectedOutcome: 'Evidence-backed review',
            },
            skillDeclaredGoal: {
              summary: 'Review generated technical plans with source citations',
              keywords: ['plan review', 'source citation'],
              expectedOutcomes: ['review summary'],
            },
            runtimeAssessment: {
              goalSatisfaction: 'unknown',
              declaredBehaviorFit: 'unknown',
              artifactGoalMatch: 'unknown',
              userFeeling: 'neutral',
            },
            typeSpecificAssessment: {
              summary: '咨询型能力需要补强证据引用。',
              checklist: [{
                key: 'evidence_provided',
                label: '证据是否可回溯',
                status: 'failed',
                reason: '复盘计划缺少明确来源段落。',
                evidence: ['Always cite the source section'],
                suggestionKey: 'advisory_evidence',
              }],
            },
            userExperienceSignals: {
              useful: 'unknown',
              followUp: 'unknown',
              correction: 'unknown',
              negativeFeedback: 'unknown',
              interruption: 'unknown',
              frustration: 'unknown',
            },
            reviewerSummary: 'The skill should cite evidence when reviewing plans.',
            ownerSuggestions: [{
              title: 'Keep source citation explicit',
              body: 'Add examples that show the expected source citation format.',
              evidence: ['Always cite the source section'],
              acceptanceCriteria: 'Generated reviews include a source section reference.',
              checklistItemKey: 'evidence_provided',
            }],
          }),
          durationMs: 1,
          durationApiMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUSD: 0,
          stopReason: 'stop',
          numTurns: 1,
        };
      },
    });

    assert.equal(record.model, 'sonnet');
    assert.equal(record.promptId, 'llm-enhanced-review');
    assert.equal(record.promptVersion, '2026-05-22.v7');
    assert.equal(record.enhancedReview?.skillType, 'advisory');
    assert.equal(record.enhancedReview?.typeSpecificAssessment?.checklist[0]?.key, 'evidence_provided');
    assert.equal(record.enhancedReview?.extractedStandards?.standardNodes?.[0]?.nodeId, 'main.review');
    assert.equal(record.enhancedReview?.runtimeNodeResults?.nodes[0]?.nodeId, 'main.review');
    assert.equal(record.enhancedReview?.runtimeNodeResults?.nodes[0]?.status, 'passed');
    assert.deepEqual(record.enhancedReview?.skillDeclaredGoal?.keywords, ['plan review', 'source citation']);
    assert.equal(record.enhancedReview?.runtimeAssessment?.userFeeling, 'neutral');
    assert.ok(record.enhancedReview?.ownerSuggestions?.some((item) => item.title === '补充标准化硬性规则声明'));
    assert.ok(record.enhancedReview?.ownerSuggestions?.some((item) => item.title === '补充标准化流程和完成标准'));
    assert.equal(record.enhancedReview?.ownerSuggestions?.some((item) => item.title === '补充用户反馈采集点'), false);
    assert.equal(record.standards.length, 2);
    assert.equal(record.standards[0].status, 'pending_review');
    assert.equal(record.standards[0].source, 'llm_soft_standard');

    const loaded = loadSkillDerivedStandards(dir);
    assert.equal(loaded['sample-review-skill'].standards[0].status, 'pending_review');

    const updated = updateSkillDerivedStandardStatus(
      dir,
      'sample-review-skill',
      record.standards[0].id,
      'author_confirmed',
      '2026-05-01T00:01:00.000Z',
    );
    assert.equal(updated.standards[0].status, 'author_confirmed');

    const resolved = resolveSkillStandards('sample-review-skill', {
      observationsDir: dir,
      skillChain: chain,
      derivedStandards: loadSkillDerivedStandards(dir),
    });
    assert.equal(resolved.active.length, 1);
    assert.equal(resolved.active[0].source, 'confirmed_soft');
    assert.equal(resolved.candidates.some((item) => item.status === 'pending_review'), true);
  });

  it('does not overwrite reviewed soft standards when prompt version changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-soft-standards-reviewed-'));
    const chain: ObservationSkillChain = {
      skillName: 'reviewed-skill',
      definition: {
        found: true,
        path: '/tmp/reviewed-skill/SKILL.md',
        content: '# reviewed-skill\n\nUse this skill to review plans.',
      },
      healthCheck: {
        source: 'doctor-static-rules',
        hardRules: { declared: false, valid: true, count: 0, rules: [], errors: [] },
        workflows: { declared: false, valid: true, branchCount: 0, nodeCount: 0, workflows: [], errors: [], source: 'none' },
      },
      runtime: {
        supported: true,
        mode: 'deterministic-no-llm',
        message: 'runtime summary only',
        summary: {
          invocationCount: 1,
          toolCallCount: 1,
          toolFailureCount: 0,
          passedCount: 0,
          attentionCount: 0,
          manualReviewCount: 0,
        },
        hardRules: [],
        workflowNodes: [],
      },
    };
    mkdirSync(skillDerivedStandardsDir(dir), { recursive: true });
    writeFileSync(skillDerivedStandardsPath(dir, chain.skillName), JSON.stringify({
      kind: 'observe-skill-derived-standards',
      schemaVersion: 1,
      skillName: chain.skillName,
      generatedAt: '2026-05-18T00:00:00.000Z',
      model: 'sonnet',
      executor: 'test-executor',
      promptId: 'llm-enhanced-review',
      promptVersion: '2026-05-18.v1',
      promptHash: 'old-prompt-hash',
      standards: [{
        id: 'soft-confirmed',
        kind: 'hard_rule_candidate',
        status: 'author_confirmed',
        title: '确认过的规则',
        body: '这条规则已经被作者确认，prompt 升级时不能被覆盖。',
        source: 'llm_soft_standard',
        confidence: 'medium',
        evidence: ['旧记录'],
      }, {
        id: 'soft-rejected',
        kind: 'workflow_candidate',
        status: 'rejected',
        title: '否决过的流程',
        body: '这条流程已经被作者否决，prompt 升级时不能被覆盖。',
        source: 'llm_soft_standard',
        confidence: 'low',
        evidence: ['旧记录'],
      }],
    }, null, 2));

    const record = await extractSkillSoftStandards({
      observationsDir: dir,
      skillChain: chain,
      model: 'sonnet',
      executorName: 'test-executor',
      now: '2026-05-19T00:00:00.000Z',
      executor: async () => {
        throw new Error('LLM should not run when reviewed soft standards exist');
      },
    });

    assert.equal(record.standards.length, 2);
    assert.equal(record.standards[0].id, 'soft-confirmed');
    assert.equal(record.standards[0].status, 'stale');
    assert.equal(record.standards[1].id, 'soft-rejected');
    assert.equal(record.standards[1].status, 'rejected');
  });

  it('preserves stale soft standards across consecutive runs after prompt upgrade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-soft-standards-stale-'));
    const chain: ObservationSkillChain = {
      skillName: 'stale-only-skill',
      definition: {
        found: true,
        path: '/tmp/stale-only-skill/SKILL.md',
        content: '# stale-only-skill\n\nUse this skill to review plans.',
      },
      healthCheck: {
        source: 'doctor-static-rules',
        hardRules: { declared: false, valid: true, count: 0, rules: [], errors: [] },
        workflows: { declared: false, valid: true, branchCount: 0, nodeCount: 0, workflows: [], errors: [], source: 'none' },
      },
      runtime: {
        supported: true,
        mode: 'deterministic-no-llm',
        message: 'runtime summary only',
        summary: {
          invocationCount: 1,
          toolCallCount: 1,
          toolFailureCount: 0,
          passedCount: 0,
          attentionCount: 0,
          manualReviewCount: 0,
        },
        hardRules: [],
        workflowNodes: [],
      },
    };
    mkdirSync(skillDerivedStandardsDir(dir), { recursive: true });
    writeFileSync(skillDerivedStandardsPath(dir, chain.skillName), JSON.stringify({
      kind: 'observe-skill-derived-standards',
      schemaVersion: 1,
      skillName: chain.skillName,
      generatedAt: '2026-05-18T00:00:00.000Z',
      model: 'sonnet',
      executor: 'test-executor',
      promptId: 'llm-enhanced-review',
      promptVersion: '2026-05-18.v1',
      promptHash: 'old-prompt-hash',
      standards: [{
        id: 'soft-only-confirmed',
        kind: 'hard_rule_candidate',
        status: 'author_confirmed',
        title: '唯一一条确认规则',
        body: '只有 author_confirmed 的旧文件，连续跑两次也不能被覆盖。',
        source: 'llm_soft_standard',
        confidence: 'medium',
        evidence: ['旧记录'],
      }],
    }, null, 2));

    const executor = async () => {
      throw new Error('LLM should not run when stale soft standards exist');
    };

    const first = await extractSkillSoftStandards({
      observationsDir: dir,
      skillChain: chain,
      model: 'sonnet',
      executorName: 'test-executor',
      now: '2026-05-19T00:00:00.000Z',
      executor,
    });
    assert.equal(first.standards.length, 1);
    assert.equal(first.standards[0].id, 'soft-only-confirmed');
    assert.equal(first.standards[0].status, 'stale');

    const second = await extractSkillSoftStandards({
      observationsDir: dir,
      skillChain: chain,
      model: 'sonnet',
      executorName: 'test-executor',
      now: '2026-05-20T00:00:00.000Z',
      executor,
    });
    assert.equal(second.standards.length, 1);
    assert.equal(second.standards[0].id, 'soft-only-confirmed');
    assert.equal(second.standards[0].status, 'stale');
  });

  it('prepends required ownerSuggestions so they survive the 10-item cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-soft-standards-prepend-'));
    const chain: ObservationSkillChain = {
      skillName: 'prepend-skill',
      definition: {
        found: true,
        path: '/tmp/prepend-skill/SKILL.md',
        content: '# prepend-skill\n\nUse this skill to review plans.',
      },
      healthCheck: {
        source: 'doctor-static-rules',
        hardRules: { declared: false, valid: true, count: 0, rules: [], errors: [] },
        workflows: { declared: false, valid: true, branchCount: 0, nodeCount: 0, workflows: [], errors: [], source: 'none' },
      },
      runtime: {
        supported: true,
        mode: 'deterministic-no-llm',
        message: 'runtime summary only',
        summary: {
          invocationCount: 1,
          toolCallCount: 1,
          toolFailureCount: 0,
          passedCount: 0,
          attentionCount: 0,
          manualReviewCount: 0,
        },
        hardRules: [],
        workflowNodes: [],
      },
    };

    const llmSuggestions = Array.from({ length: 10 }, (_, i) => ({
      title: `LLM 普通建议 ${i + 1}`,
      body: `第 ${i + 1} 条建议，跟兜底主题不沾边。`,
      acceptanceCriteria: `按第 ${i + 1} 步评估。`,
    }));
    const llmOutput = JSON.stringify({ ownerSuggestions: llmSuggestions });

    const record = await extractSkillSoftStandards({
      observationsDir: dir,
      skillChain: chain,
      model: 'sonnet',
      executorName: 'test-executor',
      now: '2026-05-19T00:00:00.000Z',
      executor: async () => ({
        ok: true,
        output: llmOutput,
        durationMs: 1,
        durationApiMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        stopReason: 'stop',
        numTurns: 1,
      }),
    });

    const finalSuggestions = record.enhancedReview?.ownerSuggestions ?? [];
    assert.equal(finalSuggestions.length, 10);
    assert.equal(finalSuggestions[0].title, '补充标准化硬性规则声明');
    assert.equal(finalSuggestions[1].title, '补充标准化流程和完成标准');
    // LLM 普通建议被前置兜底挤掉最后 2 条，其余 8 条仍按顺序保留；反馈建议没有事实门禁时不再强制注入。
    assert.equal(finalSuggestions[2].title, 'LLM 普通建议 1');
    assert.equal(finalSuggestions[9].title, 'LLM 普通建议 8');
  });
});
