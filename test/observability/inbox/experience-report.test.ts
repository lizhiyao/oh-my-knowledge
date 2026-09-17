import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildObservationInboxReport } from '../../../src/observability/inbox/index.js';
import {
  compactObservationExperienceReport,
  normalizeObservationExperienceReport,
} from '../../../src/observability/experience.js';
import {
  observationMetricAnnotationTargetId,
  observationReviewStateKey,
} from '../../../src/observability/inbox/review-state.js';
import { claudeTrace } from '../../helpers/claude-trace.js';

describe('observe inbox - experience report', () => {
  it('fails closed instead of throwing when persisted aggregates overflow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-overflow-'));
    for (const [index, sessionId] of ['overflow-a', 'overflow-b'].entries()) {
      const records = claudeTrace(sessionId, { startAt: `2026-05-0${index + 1}T00:00:00.000Z` })
        .userCommand('audit', 'Inspect it.')
        .assistantText('Done.');
      writeFileSync(join(dir, `${sessionId}.jsonl`), records.toJsonl());
    }

    const experience = buildObservationInboxReport(dir).experience;
    assert.ok(experience);
    assert.equal(experience.invocations.length, 2);
    assert.equal(experience.sessions.length, 2);
    const compact = compactObservationExperienceReport(experience);
    for (const invocation of compact.invocations) {
      invocation.indicators.userMessageCount = Number.MAX_SAFE_INTEGER;
    }
    for (const session of compact.sessions) {
      session.indicators.userMessageCount = Number.MAX_SAFE_INTEGER;
      if (session.reviewerReport) {
        session.reviewerReport.oneLookMetrics.userMessageCount = Number.MAX_SAFE_INTEGER;
      }
    }

    assert.doesNotThrow(() => normalizeObservationExperienceReport(compact));
    assert.equal(normalizeObservationExperienceReport(compact), null);
  });

  it('links a late tool result back to the originating invocation timeline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-late-result-'));
    const file = join(dir, 'session.jsonl');
    const records = claudeTrace('s-late')
      .userCommand('audit', 'Inspect it.')
      .assistantToolUse('late-call', 'Read', { file_path: '/repo-a/a.ts' })
      .userCommand('review', 'Review it.')
      .userToolResult('late-call', 'failed', { isError: true })
      .assistantText('Review complete.');
    writeFileSync(file, records.toJsonl());

    const experience = buildObservationInboxReport(file).experience;
    assert.ok(experience);
    const audit = experience.invocations.find((invocation) => invocation.skillName === 'audit');
    const review = experience.invocations.find((invocation) => invocation.skillName === 'review');
    assert.ok(audit);
    assert.ok(review);
    assert.equal(audit.metrics.numToolCalls, 1);
    assert.equal(audit.metrics.numToolFailures, 1);
    assert.equal(audit.metrics.numToolUnknown, 0);
    assert.ok(audit.timeline.some((event) =>
      event.kind === 'tool_result'
      && event.toolUseId === 'late-call'
      && event.toolStatus === 'failure'
    ));
    assert.ok(review.timeline.some((event) =>
      event.kind === 'tool_result'
      && event.toolUseId === 'late-call'
    ));
    assert.equal(audit.indicators.toolFailureCount, 1);
    assert.equal(audit.evidenceChain.toolFailureResultCount, 1);
    assert.equal(review.metrics.numToolCalls, 0);
    assert.equal(review.indicators.toolFailureCount, 0);
    assert.equal(review.evidenceChain.toolFailureResultCount, 0);

    const hydrated = normalizeObservationExperienceReport(
      compactObservationExperienceReport(experience),
    );
    assert.ok(hydrated);
    assert.ok(hydrated.invocations.find((invocation) => invocation.skillName === 'audit')?.timeline.some(
      (event) => event.kind === 'tool_result' && event.toolUseId === 'late-call',
    ));
  });

  it('keeps cancelled tool results out of failure evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-cancelled-result-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        timestamp: '2026-05-01T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 's-cancelled', cwd: '/repo-a', model_provider: 'openai' },
      },
      {
        timestamp: '2026-05-01T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '<command-name>/audit</command-name>\nInspect it.' },
      },
      {
        timestamp: '2026-05-01T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'cancelled-call',
          name: 'exec_command',
          arguments: '{"cmd":"rg needle"}',
        },
      },
      {
        timestamp: '2026-05-01T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'cancelled-call',
          status: 'cancelled',
          output: '',
        },
      },
    ];
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));

    const experience = buildObservationInboxReport(file).experience;
    assert.ok(experience);
    const audit = experience.invocations.find((invocation) => invocation.skillName === 'audit');
    assert.ok(audit);
    assert.equal(audit.metrics.numToolFailures, 0);
    assert.equal(audit.metrics.numToolCancelled, 1);
    assert.equal(audit.metrics.numToolUnknown, 0);
    assert.equal(audit.indicators.toolFailureCount, 0);
    assert.equal(audit.indicators.toolCancelledCount, 1);
    assert.equal(audit.evidenceChain.toolFailureResultCount, 0);
    assert.ok(audit.timeline.some((event) =>
      event.kind === 'tool_result'
      && event.toolUseId === 'cancelled-call'
      && event.toolStatus === 'cancelled'
      && event.isError === false
    ));

    const hydrated = normalizeObservationExperienceReport(
      compactObservationExperienceReport(experience),
    );
    assert.ok(hydrated);
    const hydratedAudit = hydrated.invocations.find((invocation) => invocation.skillName === 'audit');
    assert.equal(hydratedAudit?.metrics.numToolCancelled, 1);
    assert.equal(hydratedAudit?.indicators.toolCancelledCount, 1);
  });

  it('does not reinterpret an explicit unknown tool status from output text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-unknown-result-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        timestamp: '2026-05-01T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 's-unknown', cwd: '/repo-a', model_provider: 'openai' },
      },
      {
        timestamp: '2026-05-01T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '<command-name>/audit</command-name>\nInspect it.' },
      },
      {
        timestamp: '2026-05-01T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'unknown-call',
          name: 'exec_command',
          arguments: '{"cmd":"rg needle"}',
        },
      },
      {
        timestamp: '2026-05-01T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'unknown-call',
          status: 'unknown',
          output: 'Error: terminal status was not reported',
        },
      },
    ];
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));

    const experience = buildObservationInboxReport(file).experience;
    assert.ok(experience);
    const audit = experience.invocations.find((invocation) => invocation.skillName === 'audit');
    assert.ok(audit);
    assert.equal(audit.metrics.numToolFailures, 0);
    assert.equal(audit.metrics.numToolUnknown, 1);
    assert.equal(audit.indicators.toolFailureCount, 0);
    assert.equal(audit.indicators.toolUnknownCount, 1);
    assert.equal(audit.evidenceChain.toolFailureResultCount, 0);

    const compact = compactObservationExperienceReport(experience);
    const hydrated = normalizeObservationExperienceReport(compact);
    assert.ok(hydrated);
    const contradictory = structuredClone(compact);
    const unknownResult = contradictory.traceTimelines[0].tree.main.find(
      (event) => event.kind === 'tool_result' && event.toolStatus === 'unknown',
    );
    assert.ok(unknownResult);
    unknownResult.isError = true;
    assert.equal(normalizeObservationExperienceReport(contradictory), null);
  });

  it('builds evidence-only experience report for 2.0 skill review', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    // u3 的 uuid 被下方 reviewState 断言引用，显式保留；其余 uuid 交给 builder。
    const records = claudeTrace('s1')
      .event({
        type: 'user',
        uuid: 'u-runtime',
        parentUuid: null,
        promptId: 'p1',
        timestamp: '2026-05-01T00:00:00.000Z',
        entrypoint: 'sdk-ts',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '进入新增模板流程。当前页面已经完成本地工作区恢复，请直接命中 gui-workflow route。若设计工具链因为登录态失败且存在 token，则改走回退，必须不要误判 token。' }],
        },
      })
      .userCommand('audit', 'Find revenue schema', {
        timestamp: '2026-05-01T00:00:00.500Z',
        extra: { entrypoint: 'cli' },
      })
      .assistantToolUses([
        { id: 't1', name: 'Grep', input: { pattern: 'revenue_schema', path: '/repo-a' } },
        { id: 't2', name: 'Read', input: { file_path: '/repo-a/schema.ts' } },
      ], { timestamp: '2026-05-01T00:00:01.000Z' })
      .userToolResults([
        { toolUseId: 't1', content: 'No matches found', isError: false },
        { toolUseId: 't2', content: 'opaque runtime response' },
      ], { timestamp: '2026-05-01T00:00:02.000Z' })
      .event({
        type: 'user',
        uuid: 'u-meta',
        timestamp: '2026-05-01T00:00:02.500Z',
        isMeta: true,
        sourceToolUseID: 'skill-tool-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Base directory for this skill: /repo-a/.claude/skills/audit\n\n# audit\n\n不对，这里是 skill 文档里的规则，不是用户说的话。' }],
        },
      })
      .userText('不对，必须直接找到 schema 定义，不要猜。', { uuid: 'u3', timestamp: '2026-05-01T00:00:03.000Z' })
      .userText('[Request interrupted by user]', { uuid: 'u4', timestamp: '2026-05-01T00:00:04.000Z' });
    writeFileSync(file, records.toJsonl());

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
    assert.deepEqual(experience.skills[0].toolCounts, { Grep: 1, Read: 1 });
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
    assert.equal(experience.invocations[0].indicators.toolCallCount, 2);
    assert.equal(experience.invocations[0].indicators.toolFailureCount, 0);
    assert.equal(experience.invocations[0].indicators.toolUnknownCount, 1);
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
    assert.equal(reviewerReport.oneLookMetrics.tokenUsage.observedInvocationCount, 0);
    assert.equal(reviewerReport.oneLookMetrics.tokenUsage.coverage, 0);
    assert.equal(reviewerReport.oneLookMetrics.assistantProgressUpdateCount, 0);
    assert.equal(reviewerReport.oneLookMetrics.finalDeliverySignalCount, 0);
    assert.equal(reviewerReport.oneLookMetrics.toolUnknownCount, 1);
    assert.equal(
      reviewerReport.chainSteps.find((step) => step.label === '执行流程')?.status,
      'unknown',
    );
    assert.ok(reviewerReport.traceLinks.some((ref) => ref.messageUuid === 'u3'));
    assert.ok(reviewerReport.authorSuggestions.length > 0);
    assert.equal('llmAnnotation' in reviewerReport, false);

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
        schemaVersion: 2,
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
    const records = claudeTrace('s1', { cwd: dir })
      .userCommand('audit', '检查示例配置')
      .assistantToolUse('t1', 'Bash', { command: 'node check.js' })
      .userToolResult('t1', '{"result":{"body":"{\\"status\\":\\"error\\",\\"error\\":\\"synthetic failure\\"}"}}');
    writeFileSync(file, records.toJsonl());

    const report = buildObservationInboxReport(file);
    const session = report.experience!.sessions[0];
    assert.equal(session.indicators.toolFailureCount, 1);
    assert.equal(session.evidenceChain.toolFailureResultCount, 1);
    assert.ok(session.ruleFindings.some((finding) => finding.code === 'tool_failure_seen'));
    assert.ok(session.reviewerReport?.findings.some((finding) => finding.ruleSource === 'tool_error_recovery'));
  });

  it('does not override an explicit successful tool status from error-like payload text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-explicit-tool-success-'));
    const file = join(dir, 'session.jsonl');
    const records = claudeTrace('s1', { cwd: dir })
      .userCommand('audit', '检查示例配置')
      .assistantToolUse('t1', 'Read', { file_path: 'errors.json' })
      .userToolResult('t1', '{"error":"synthetic failure"}', { isError: false });
    writeFileSync(file, records.toJsonl());

    const report = buildObservationInboxReport(file);
    const session = report.experience!.sessions[0];
    assert.equal(session.indicators.toolFailureCount, 0);
    assert.equal(session.evidenceChain.toolFailureResultCount, 0);
    assert.equal(session.ruleFindings.some((finding) => finding.code === 'tool_failure_seen'), false);
  });

  it('emits session_interrupted finding for assistant turn failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-session-interrupted-'));
    const file = join(dir, 'session.jsonl');
    const records = claudeTrace('s1', { cwd: dir })
      .userCommand('audit', '检查示例配置')
      .assistantToolUse('t1', 'Read', { file_path: 'README.md' })
      .event({ type: 'system', message: '[assistant turn failed]' });
    writeFileSync(file, records.toJsonl());

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
    const records = claudeTrace('s1', { cwd: dir })
      .userCommand('audit', '检查示例配置')
      .assistantToolUse('t1', 'Read', { file_path: 'README.md' })
      .event({ type: 'session.ended' })
      .event({ type: 'session.started' });
    writeFileSync(file, records.toJsonl());

    const report = buildObservationInboxReport(file);
    const session = report.experience!.sessions[0];
    assert.equal(session.indicators.sessionInterruptedCount, 1);
    assert.ok(session.ruleFindings.some((finding) => finding.code === 'session_interrupted_seen' && finding.level === 'attention'));
    assert.ok(session.reviewerReport?.findings.some((finding) => finding.ruleSource === 'session_interrupted'));
  });

  it('keeps user feedback unknown until positive feedback is observed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-feedback-unknown-'));
    const file = join(dir, 'session.jsonl');
    const records = claudeTrace('s1', { cwd: dir })
      .userCommand('audit', '检查示例配置')
      .assistantText('已完成，结果如下：示例配置正常。');
    writeFileSync(file, records.toJsonl());

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
    const records = claudeTrace('s1', { cwd: dir })
      .userCommand('yuque', '读取示例文档')
      .assistantToolUse('t1', 'Bash', { command: 'echo noop' });
    writeFileSync(file, records.toJsonl());

    const report = buildObservationInboxReport(file);
    const executionStep = report.experience!.sessions[0].reviewerReport?.chainSteps.find((step) => step.label === '执行流程');
    assert.equal(executionStep?.status, 'attention');
    assert.match(executionStep?.text ?? '', /没有命中能力声明的核心工具/);
    assert.ok(report.experience!.sessions[0].reviewerReport?.findings.some((finding) => finding.ruleSource === 'expected_tools_missed'));
  });

  it('keeps skill timeline open through skill context until the next skill starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = claudeTrace('s1')
      .userText('画一个给老板汇报的时序图。步骤简单一点', {
        timestamp: '2026-05-09T06:02:08.236Z',
        extra: { entrypoint: 'cli' },
      })
      .assistantToolUse('skill-tool-1', 'Skill', { skill: 'my-diagram', args: '画时序图' }, {
        timestamp: '2026-05-09T06:02:15.646Z',
      })
      .userToolResult('skill-tool-1', 'Launching skill: my-diagram', {
        timestamp: '2026-05-09T06:02:16.500Z',
      })
      .event({
        type: 'user',
        uuid: 'u3',
        timestamp: '2026-05-09T06:02:16.115Z',
        isMeta: true,
        sourceToolUseID: 'skill-tool-1',
        message: { role: 'user', content: 'Base directory for this skill: /repo-a/.claude/skills/my-diagram\n# my-diagram\n画图流程说明' },
      })
      .assistantText('内容、类型、格式都已明确，直接生成 Mermaid 时序图。', {
        timestamp: '2026-05-09T06:02:24.003Z',
      })
      .userText('把这个时序图的系统-工具改为 agent，做一个diff图', {
        uuid: 'u4',
        timestamp: '2026-05-09T06:03:28.380Z',
      })
      .assistantText('Diff 需要红色标注，推荐用 PlantUML。', {
        timestamp: '2026-05-09T06:03:46.528Z',
      })
      // a4 与 a3 同挂 u4（分叉）：显式 parentUuid，不挂到 a3。
      .assistantToolUse('skill-tool-2', 'Skill', { skill: 'excalidraw-diagram', args: 'before after' }, {
        parentUuid: 'u4',
        timestamp: '2026-05-09T06:07:23.444Z',
      });
    writeFileSync(file, records.toJsonl());

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
    const mainRecords = claudeTrace('sessionA', { startAt: '2026-05-11T02:00:00.000Z' })
      .userCommand('apply-cc', '帮我咨询 PRD 方案。')
      .assistantText('根据 TOOLS.md 规则，功能咨询类需求走 `aiprd-task-runner` skill 的 `/consult` 流程。')
      .assistantToolUse('task1', 'Task', { prompt: '启动子 Claude 到 AIPRDWorkSpace 执行 /consult' })
      .assistantText('已发送进展：子 Claude 数据采集完成，正在整理咨询结果写入文件，即将完成。');
    const childRecords = claudeTrace('child-1', { startAt: '2026-05-11T02:00:04.000Z' })
      .userCommand('aiprd-task-runner', '/consult PRD 方案')
      .assistantToolUse('read1', 'Read', { file_path: '/repo-a/prd.md' })
      .assistantText('最终报告如下：PRD 方案建议分为目标、范围、验收标准三部分。');
    writeFileSync(mainFile, mainRecords.toJsonl());
    writeFileSync(childFile, childRecords.toJsonl());

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
    const childEdge = firstEpisode.orchestrationEdges.find((edge) =>
      edge.parentSkillSegmentId === applySegment.id
      && edge.edgeKind === 'external_child_session'
      && edge.evidenceRefs.some((ref) => ref.sourceTrace === mainFile && ref.toolUseId === 'task1')
    );
    assert.ok(childEdge);
    assert.equal(childEdge.runnerStartedRef?.toolUseId, 'task1');
    assert.equal(childEdge.status, 'started');
    assert.ok(story.nodes.some((node) => node.kind === 'subagent_branch'));
    assert.deepEqual(story.skillLinks.map((link) => [link.skillName, link.role]).sort(), [
      ['aiprd-task-runner', 'executor'],
      ['apply-cc', 'router'],
    ]);
    assert.ok(story.graph.edges.some((edge) => edge.label === '路由'));
    assert.equal(applySession.reviewerReport?.sessionStory.schemaVersion, story.schemaVersion);
    assert.equal(applySession.reviewerReport?.chainSteps.find((step) => step.label === '结果 / 产物')?.status, 'unknown');
    assert.equal(applySession.indicators.routerDownstreamCompleted, 1);
    assert.ok(report.experience);
    const compact = compactObservationExperienceReport(report.experience);
    assert.equal(compact.storyContexts[0].episodes.length > 0, true);
    assert.equal('episodes' in compact.sessions[0].sessionStory!, false);
    const hydrated = normalizeObservationExperienceReport(compact);
    assert.ok(hydrated);
    assert.equal(hydrated.sessions[0].indicators.routerDownstreamCompleted, 1);
  });

  it('attributes observations to the originating trace when main and subagent invoke the same skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-observation-trace-attribution-'));
    const sessionDir = join(dir, 'sessionA');
    const subagentsDir = join(sessionDir, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const mainFile = join(sessionDir, 'main.jsonl');
    const childFile = join(subagentsDir, 'child.jsonl');
    writeFileSync(mainFile, claudeTrace('sessionA', { startAt: '2026-05-11T03:00:00.000Z' })
      .userCommand('audit', '主代理先检查。')
      .assistantText('主代理检查完成。', { timestamp: '2026-05-11T03:00:08.000Z' })
      .toJsonl());
    writeFileSync(childFile, claudeTrace('child-1', { startAt: '2026-05-11T03:00:03.000Z' })
      .userCommand('audit', '子代理并行检查。')
      .assistantToolUse('grep-child', 'Grep', { pattern: 'audit_rule', path: '/repo-a' })
      .userToolResult('grep-child', 'No files found', { isError: true })
      .toJsonl());

    const report = buildObservationInboxReport(sessionDir);
    assert.equal(report.items.length, 1);
    const invocations = report.experience?.invocations.filter((invocation) => invocation.skillName === 'audit') ?? [];
    const mainInvocation = invocations.find((invocation) => invocation.sourceTrace === mainFile);
    const childInvocation = invocations.find((invocation) => invocation.sourceTrace === childFile);
    assert.ok(mainInvocation);
    assert.ok(childInvocation);
    assert.equal(mainInvocation.relatedObservationIds.length, 0);
    assert.equal(mainInvocation.indicators.highObservationCount, 0);
    assert.deepEqual(childInvocation.relatedObservationIds, [report.items[0].id]);
    assert.ok(childInvocation.evidenceRefs.some((ref) => ref.sourceTrace === childFile));
  });

  it('attributes feedback by target object instead of the current skill window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-feedback-object-'));
    const file = join(dir, 'session.jsonl');
    const records = claudeTrace('s1', { startAt: '2026-05-11T02:00:00.000Z' })
      .userCommand('damai-daily', '生成日报。')
      .assistantToolUse('tool1', 'Bash', { command: 'node run-damai.js' })
      .userText('[文件: omk-reviewer.zip]')
      .userCommand('omk-reviewer', '看下这个 skill 的执行流程。')
      .assistantToolUse('tool2', 'Read', { file_path: '/repo-a/omk-reviewer/SKILL.md' });
    writeFileSync(file, records.toJsonl());

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

  it('keeps apply-cc promise follow-up separate from unrelated preview feedback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-feedback-promise-'));
    const file = join(dir, 'session.jsonl');
    const records = claudeTrace('s1', { startAt: '2026-05-11T02:00:00.000Z' })
      .userCommand('apply-cc', '让子 Claude 分析项目。')
      .assistantText('已启动子 Claude，完成后我会同步结果。session: claude-test123')
      .userText('怎么样了')
      .userCommand('ai-worker-webtools', '用可预览的链接发给我')
      .assistantToolUse('tool1', 'Bash', { command: 'python3 -m http.server 8899' });
    writeFileSync(file, records.toJsonl());

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
    const records = claudeTrace('s1', { startAt: '2026-05-11T02:00:00.000Z' })
      .userCommand('apply-cc', '帮我看一下服务器上的文件。')
      .assistantText('可以，我先确认文件位置。')
      .userText('我现在能够ssh到你的服务器，我应该怎么把这个文件发送到我本地');
    writeFileSync(file, records.toJsonl());

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
    const records = claudeTrace('s1', { startAt: '2026-05-11T02:00:00.000Z' })
      .userCommand('aiprd-task-runner', '功能咨询：新版确认页是什么逻辑，有开关控制吗')
      .assistantToolUse('runner1', 'Bash', {
        command: 'node ~/.openclaw/workspace-main/skills/apply-cc/scripts/runner.js ~/code/project "功能咨询" "/consult 功能咨询：新版确认页是什么逻辑，有开关控制吗"',
      })
      .assistantText('已启动功能咨询，session: claude-router-test，有结果我会直接同步给你。')
      .userText('进度', { timestamp: '2026-05-11T02:30:00.000Z' })
      .userText('为什么信息没返回', { timestamp: '2026-05-11T02:40:00.000Z' });
    writeFileSync(file, records.toJsonl());

    const report = buildObservationInboxReport(file);
    const routerSession = report.experience?.sessions.find((session) => session.skillName === 'aiprd-task-runner');
    const executorSession = report.experience?.sessions.find((session) => session.skillName === 'apply-cc');
    assert.ok(routerSession);
    assert.ok(executorSession);
    assert.equal(routerSession.indicators.routerDownstreamCompleted, 0);
    assert.equal(routerSession.indicators.routerDownstreamFailed, 1);
    const indicators = routerSession.indicators;
    assert.equal(
      routerSession.reviewPriorityScore,
      indicators.highObservationCount * 3
        + indicators.mediumObservationCount
        + indicators.userCorrectionCount * 2
        + indicators.userInterruptionCount * 2
        + indicators.sessionInterruptedCount * 2
        + indicators.negativeFeedbackCount * 2
        + indicators.hardRuleTextHitCount
        + indicators.toolFailureCount
        + indicators.routerDownstreamFailed * 2
        + indicators.hedgingCount
        + indicators.explicitMarkerCount * 2,
    );
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
    const records = claudeTrace('s1', { startAt: '2026-05-11T02:00:00.000Z' })
      .userCommand('apply-cc', '帮我咨询 PRD 方案。')
      .assistantText('根据 TOOLS.md 规则，功能咨询类需求走 aiprd-task-runner skill。')
      .userCommand('aiprd-task-runner', '/consult PRD 方案')
      .assistantToolUse('read1', 'Read', { file_path: '/repo-a/prd.md' });
    writeFileSync(file, records.toJsonl());

    const report = buildObservationInboxReport(file);
    const applySession = report.experience?.sessions.find((session) => session.skillName === 'apply-cc');
    const runnerSession = report.experience?.sessions.find((session) => session.skillName === 'aiprd-task-runner');
    assert.ok(applySession);
    assert.ok(runnerSession);
    assert.equal(applySession.timelinePreview.some((event) => event.messageUuid === 'u2'), false);
    assert.equal(runnerSession.timelinePreview.some((event) => event.messageUuid === 'u2' && event.kind === 'user_message'), true);
  });
});
