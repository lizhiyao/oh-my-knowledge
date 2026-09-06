import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildObservationInboxReport } from '../../../src/observability/inbox/index.js';
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
  type ExperienceSessionSummary,
} from '../../../src/observability/experience.js';
import { hasExplicitFollowUpCorrectionSignal } from '../../../src/observability/inbox/feedback-matchers.js';
import {
  hasAssistantDeliverySignalText,
  hasUserHardRuleText,
  isAssistantProgressUpdateText,
} from '../../../src/observability/experience/text-signals.js';
import {
  isRuntimeProtocolPromptText,
  isScheduledTaskPromptText,
  isSyntheticUserMessageText,
  isUserInteractionMetricText,
  isWorkflowSystemUserMessageText,
} from '../../../src/observability/trace/message-classification.js';
import {
  observationMetricAnnotationTargetId,
  observationReviewStateKey,
} from '../../../src/observability/inbox/review-state.js';
import { renderObservationInboxPage } from '../../../src/studio/presentation/observation-inbox-renderer.js';
import { businessActionTag, checklistItem, reviewProjectionForFixture } from './_helpers.js';

describe('observe inbox - signal detection', () => {
  it('does not count embedded words as user correction signals', () => {
    assert.equal(hasUserCorrectionSignal('这里的拆解不对称，是不是需要换一种图形？'), false);
    assert.equal(hasUserCorrectionSignal('不对，应该直接使用原来的分组。'), true);
    assert.equal(hasUserCorrectionSignal('这里不是；重来。'), true);
    const text = '这里的拆解不对称。不是，重新看。';
    assert.deepEqual(findUserCorrectionMatches(text).map((range) => text.slice(range.start, range.end)), ['不是']);
  });

  it('keeps follow-up task linkage stricter than statistical correction metrics', () => {
    assert.equal(hasUserCorrectionSignal('改成检查另一个模块。'), true);
    assert.equal(hasExplicitFollowUpCorrectionSignal('改成检查另一个模块。'), false);
    assert.equal(hasExplicitFollowUpCorrectionSignal('不对吧，应该保留原来的交互。'), true);
    assert.equal(hasExplicitFollowUpCorrectionSignal('这个不对，应该保留原来的交互。'), true);
    assert.equal(hasExplicitFollowUpCorrectionSignal("That's wrong. Keep the original interaction."), true);
    assert.equal(hasExplicitFollowUpCorrectionSignal('That is incorrect. Keep the original interaction.'), true);
  });

  it('detects neutral user goal shift separately from correction', () => {
    const text = '先不看这个，换个方向，另外一个问题后面再处理。';
    assert.deepEqual(findUserGoalShiftMatches(text).map((range) => text.slice(range.start, range.end)), ['先不', '换个方向', '另外一个问题']);
    assert.equal(hasUserCorrectionSignal(text), false);
  });

  it('detects source-neutral capability-reference goal shifts', () => {
    const text = '参考 data-review skill 的做法，启动独立任务';
    assert.deepEqual(
      findUserGoalShiftMatches(text).map((range) => text.slice(range.start, range.end)),
      ['参考 data-review skill 的做法，启动'],
    );
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
      schemaVersion: 2 as const,
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
      ...reviewProjectionForFixture(annotatedReport.experience!, reviewState),
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
});
