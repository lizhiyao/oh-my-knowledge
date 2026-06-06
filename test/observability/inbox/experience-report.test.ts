import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildObservationInboxReport } from '../../../src/observability/inbox.js';
import {
  observationMetricAnnotationTargetId,
  observationReviewStateKey,
} from '../../../src/observability/review-state.js';
import {
  renderFeedbackAttributionLabel,
  renderObservationInboxPage,
} from '../../../src/renderer/observation-inbox-renderer.js';
import { resolvedReviewSessionsForFixture } from './_helpers.js';

describe('observe inbox - experience report', () => {
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
    assert.equal(experience.reportKind, 'observe-experience');
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
        reportKind: 'observe-review-state',
        schemaVersion: 1,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {},
      },
      resolvedReviewSessions: resolvedReviewSessionsForFixture(experience, {
        reportKind: 'observe-review-state',
        schemaVersion: 1,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {},
      }),
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
        reportKind: 'observe-review-state',
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
});
