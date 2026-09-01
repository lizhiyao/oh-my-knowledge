import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildObservationInboxReport } from '../../../src/observability/inbox/index.js';
import {
  deleteObservationReviewState,
  loadObservationReviewState,
  observationMetricAnnotationVerdict,
  observationMetricAnnotationTargetId,
  observationMetricScopeFor,
  observationReviewStateKey,
  updateObservationReviewState,
} from '../../../src/observability/inbox/review-state.js';
import {
  extractSkillSoftStandards,
  loadSkillDerivedStandards,
  resolveSkillStandards,
  skillDerivedStandardsDir,
  skillDerivedStandardsPath,
  updateSkillDerivedStandardStatus,
} from '../../../src/observability/soft-standards/index.js';
import type { ObservationSkillChain } from '../../../src/observability/skill-health/skill-chain.js';

describe('observe inbox - review state', () => {
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
      traceId: 'trace-1',
      reason: '用户明确否定上一轮结果',
    }, '2026-05-01T00:01:30.000Z');
    const metricKey = observationReviewStateKey('evidence_metric', metricTargetId);
    assert.equal(metric.entries[metricKey].metricKey, 'user_correction');
    assert.equal(metric.entries[metricKey].metricScope, 'skill_segment');
    assert.equal(metric.entries[metricKey].metricScopeId, 'skill-session-1');
    assert.equal(metric.entries[metricKey].traceId, 'trace-1');
    assert.equal(metric.entries[metricKey].reason, '用户明确否定上一轮结果');
    assert.equal(loadObservationReviewState(dir).entries[metricKey].traceId, 'trace-1');

    const afterDelete = deleteObservationReviewState(dir, 'goal_slice_correction', 'session-1:42', '2026-05-01T00:02:00.000Z');
    assert.equal(afterDelete.entries[correctionKey], undefined);
  });

  it('fails closed on corrupt reviewer state instead of overwriting human annotations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-review-state-corrupt-'));
    const path = join(dir, 'review-state.json');
    const corrupt = JSON.stringify({
      kind: 'observe-review-state',
      schemaVersion: 2,
      updatedAt: '2026-05-01T00:00:00.000Z',
      entries: {
        'skill:kept': {
          targetType: 'skill',
          targetId: 'different-key',
          verdict: 'reviewed',
          reviewedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    });
    writeFileSync(path, corrupt);

    assert.throws(
      () => loadObservationReviewState(dir),
      /观测复核状态格式无效/,
    );
    assert.throws(
      () => updateObservationReviewState(dir, {
        targetType: 'skill',
        targetId: 'new',
        verdict: 'reviewed',
      }),
      /观测复核状态格式无效/,
    );
    assert.equal(readFileSync(path, 'utf-8'), corrupt);
  });

  it('读取时执行与写入 API 相同的 metric 契约和时间顺序校验', () => {
    const invalidStates = [
      {
        kind: 'observe-review-state',
        schemaVersion: 2,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {
          'evidence_metric:metric-1': {
            targetType: 'evidence_metric',
            targetId: 'metric-1',
            verdict: 'reviewed',
            metricKey: 'user_correction',
            reviewedAt: '2026-05-01T00:00:00.000Z',
          },
        },
      },
      {
        kind: 'observe-review-state',
        schemaVersion: 2,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {
          'skill:audit': {
            targetType: 'skill',
            targetId: 'audit',
            verdict: 'reviewed',
            metricKey: 'user_correction',
            reviewedAt: '2026-05-01T00:00:00.000Z',
          },
        },
      },
      {
        kind: 'observe-review-state',
        schemaVersion: 2,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {
          'skill:audit': {
            targetType: 'skill',
            targetId: 'audit',
            verdict: 'reviewed',
            reviewedAt: '2026-05-01T00:00:01.000Z',
          },
        },
      },
    ];

    for (const [index, state] of invalidStates.entries()) {
      const dir = mkdtempSync(join(tmpdir(), `omk-review-state-read-contract-${index}-`));
      try {
        writeFileSync(join(dir, 'review-state.json'), JSON.stringify(state));
        assert.throws(() => loadObservationReviewState(dir), /观测复核状态格式无效/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('rejects runtime-invalid review updates before writing state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-review-state-invalid-update-'));
    const invalidUpdates = [
      {
        targetType: 'evidence_metric',
        targetId: 'metric:user_correction:abc',
        verdict: 'reviewed',
        metricKey: 'user_correction',
      },
      {
        targetType: 'evidence_metric',
        targetId: 'metric:user_correction:abc',
        verdict: 'confirmed',
        metricKey: 'user_correction',
        metricScope: 'message',
      },
      {
        targetType: 'skill',
        targetId: 'audit',
        verdict: 'reviewed',
        metricKey: 'user_correction',
      },
      {
        targetType: 'inbox_item',
        targetId: 'obs-1',
        verdict: 'real_issue',
        messageIndex: -1,
      },
    ];

    for (const update of invalidUpdates) {
      assert.throws(
        () => updateObservationReviewState(
          dir,
          update as Parameters<typeof updateObservationReviewState>[1],
        ),
      );
    }
    assert.equal(loadObservationReviewState(dir).entries['skill:audit'], undefined);
  });

  it('uses review state as the effective soft-standard status without mutating the cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-soft-standard-review-source-'));
    const path = skillDerivedStandardsPath(dir, 'audit');
    mkdirSync(skillDerivedStandardsDir(dir), { recursive: true });
    writeFileSync(path, JSON.stringify({
      kind: 'observe-skill-derived-standards',
      schemaVersion: 2,
      skillName: 'audit',
      generatedAt: '2026-05-01T00:00:00.000Z',
      model: 'test-model',
      executor: 'test-executor',
      promptId: 'llm-enhanced-review',
      promptVersion: '2026-05-22.v7',
      standards: [{
        id: 'soft-1',
        kind: 'hard_rule_candidate',
        status: 'pending_review',
        title: '需要确认的规则',
        body: '需要作者确认。',
        source: 'llm_soft_standard',
        confidence: 'medium',
        evidence: [],
      }],
    }));
    updateObservationReviewState(dir, {
      targetType: 'soft_standard',
      targetId: 'audit:soft-1',
      verdict: 'real_issue',
    }, '2026-05-01T00:01:00.000Z');

    assert.equal(loadSkillDerivedStandards(dir).audit.standards[0].status, 'author_confirmed');
    assert.equal(JSON.parse(readFileSync(path, 'utf-8')).standards[0].status, 'pending_review');

    writeFileSync(path, JSON.stringify({
      ...JSON.parse(readFileSync(path, 'utf-8')),
      generatedAt: '2026-05-01T00:02:00.000Z',
    }));
    assert.equal(loadSkillDerivedStandards(dir).audit.standards[0].status, 'pending_review');
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

  it('separates physical traces and repeated tool-call occurrences while reading legacy annotations', () => {
    const ref = {
      sourceTrace: '/tmp/session.jsonl',
      sessionId: 's1',
      messageIndex: 3,
      messageUuid: 'a3',
      toolUseId: 'reused',
    };
    const traceA = observationMetricAnnotationTargetId(
      { ...ref, traceId: 'trace-a', callInstanceId: 'call-instance-1' },
      'repeated_execution',
    );
    const traceB = observationMetricAnnotationTargetId(
      { ...ref, traceId: 'trace-b', callInstanceId: 'call-instance-1' },
      'repeated_execution',
    );
    assert.notEqual(traceA, traceB);

    const first = observationMetricAnnotationTargetId(
      { ...ref, traceId: 'trace-a', callInstanceId: 'call-instance-1' },
      'repeated_execution',
    );
    const second = observationMetricAnnotationTargetId(
      { ...ref, traceId: 'trace-a', callInstanceId: 'call-instance-2' },
      'repeated_execution',
    );
    assert.notEqual(first, second);

    const legacyTargetId = observationMetricAnnotationTargetId(ref, 'repeated_execution');
    const state = {
      kind: 'observe-review-state' as const,
      schemaVersion: 2 as const,
      updatedAt: '2026-05-01T00:00:00.000Z',
      entries: {
        [observationReviewStateKey('evidence_metric', legacyTargetId)]: {
          targetType: 'evidence_metric' as const,
          targetId: legacyTargetId,
          verdict: 'rejected' as const,
          metricKey: 'repeated_execution' as const,
          reviewedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    };
    assert.equal(
      observationMetricAnnotationVerdict(
        state,
        { ...ref, traceId: 'trace-a', callInstanceId: 'call-instance-1' },
        'repeated_execution',
      ),
      'rejected',
    );
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
      schemaVersion: 2 as const,
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
      schemaVersion: 2,
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

  it('rejects the whole persisted soft-standard cache when one entry is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-soft-standards-invalid-'));
    mkdirSync(skillDerivedStandardsDir(dir), { recursive: true });
    writeFileSync(skillDerivedStandardsPath(dir, 'audit'), JSON.stringify({
      kind: 'observe-skill-derived-standards',
      schemaVersion: 2,
      skillName: 'audit',
      generatedAt: '2026-05-18T00:00:00.000Z',
      model: 'test-model',
      executor: 'test-executor',
      promptId: 'llm-enhanced-review',
      promptVersion: 'legacy-version',
      standards: [
        {
          id: 'valid',
          kind: 'hard_rule_candidate',
          status: 'pending_review',
          title: 'Valid standard',
          body: 'Keep this.',
          source: 'llm_soft_standard',
          confidence: 'medium',
          evidence: [],
        },
        {
          id: 'invalid',
          kind: 'unsupported_kind',
          status: 'pending_review',
          title: 'Invalid standard',
          body: 'Do not silently drop this.',
          source: 'llm_soft_standard',
          confidence: 'medium',
          evidence: [],
        },
      ],
    }));

    assert.deepEqual(loadSkillDerivedStandards(dir), {});
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
      schemaVersion: 2,
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
