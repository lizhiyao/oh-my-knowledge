import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildObserveDiagnostics, maxLifecycle } from '../../src/diagnosis/observe-mapper.js';
import { activeStudioDiagnostics, buildStudioDiagnosisSummary, mergeDiagnosisBundles } from '../../src/diagnosis/studio-projection.js';

describe('buildObserveDiagnostics', () => {
  it('maps observe source types into a shared diagnosis bundle', () => {
    const bundle = buildObserveDiagnostics({
      generatedAt: '2026-05-15T00:00:00.000Z',
      skillChainAdvisories: [
        {
          skillName: 'prd-create',
          code: 'workflows_not_declared',
          message: 'workflow structure was detected but not declared',
          exampleYaml: 'workflow:\n  - step: write demo',
        },
      ],
      runtimeChecks: [
        {
          skillName: 'prd-create',
          id: 'workflow-step-1',
          nodeKind: 'workflowNode',
          status: 'manual_review',
          title: 'Workflow node needs review',
          reason: 'runtime did not show the expected step',
          evidenceRefs: [{ id: 'e1', kind: 'message', sessionId: 's1', messageIndex: 3 }],
        },
        {
          skillName: 'prd-create',
          id: 'hardrule-ok',
          nodeKind: 'hardRule',
          status: 'passed',
        },
      ],
      problemPatterns: [
        {
          skillName: 'prd-create',
          bucket: 'workflow_mismatch',
          patternKey: 'workflow-mismatch:demo',
          signalTypes: ['user_correction'],
          count: 3,
          sessionCount: 2,
          recentSessionIds: ['s1', 's2'],
        },
      ],
      reviewerFindings: [
        {
          skillName: 'prd-create',
          id: 'finding-1',
          source: 'deterministic_rule',
          level: 'attention',
          ruleSource: 'final_delivery_absent',
          ruleVersion: 'v1',
          evidenceRefs: [{ id: 'e2', kind: 'message', sessionId: 's2', messageIndex: 9 }],
        },
        {
          skillName: 'prd-create',
          id: 'finding-2',
          source: 'deterministic_rule',
          level: 'low',
          ruleSource: 'final_delivery_absent',
          ruleVersion: 'v1',
          evidenceRefs: [{ id: 'e3', kind: 'message', sessionId: 's3', messageIndex: 10 }],
        },
        {
          skillName: 'prd-create',
          id: 'finding-ignored',
          source: 'deterministic_rule',
          level: 'info',
          ruleSource: 'no_priority_signal',
        },
      ],
      derivedStandards: [
        {
          skillName: 'prd-create',
          id: 'standard-1',
          standardKind: 'workflow_candidate',
          status: 'pending_review',
          title: 'Demo generation workflow should be declared',
          source: 'llm_soft_standard',
          confidence: 0.7,
        },
        {
          skillName: 'prd-create',
          id: 'standard-2',
          standardKind: 'hard_rule_candidate',
          status: 'author_confirmed',
          title: 'Use source document before generating demo',
          source: 'manual',
        },
      ],
    });

    assert.deepEqual(bundle.sourceCoverage, { observe: true, doctor: false, eval: false });
    const diagnoses = bundle.bySkill['prd-create'];
    assert.ok(diagnoses);
    assert.ok(diagnoses.some((item) => item.signal === 'workflows_not_declared'));
    assert.ok(diagnoses.some((item) => item.signal === 'runtime_workflow_review'));
    assert.ok(diagnoses.some((item) => item.signal === 'user_correction'));
    assert.ok(diagnoses.some((item) => item.signal === 'workflow_candidate'));

    const reviewer = diagnoses.find((item) => item.signal === 'final_delivery_absent');
    assert.ok(reviewer);
    assert.equal(reviewer.occurrenceCount, 2);
    assert.equal(reviewer.occurrences[0].sourceKind, 'final_delivery_absent');

    const confirmed = diagnoses.find((item) => item.signal === 'hard_rule_candidate');
    assert.ok(confirmed);
    assert.equal(confirmed.lifecycle, 'resolved');

    // problemPattern 投影后 occurrenceCount 应该用 pattern.count(3),不是默认 1。
    // 这是给 Studio 排序和 affectedCount 的关键:3 个 session 反复出现的 pattern 不能跟
    // 单点 advisory 一样按 1 算。
    const pattern = diagnoses.find((item) => item.signal === 'user_correction');
    assert.ok(pattern);
    assert.equal(pattern.occurrenceCount, 3, 'problem pattern occurrenceCount 应该等于 pattern.count');
  });

  it('builds studio projection without changing UI renderers', () => {
    const bundle = buildObserveDiagnostics({
      generatedAt: '2026-05-15T00:00:00.000Z',
      skillChainAdvisories: [
        { skillName: 'audit', code: 'skill_md_not_found' },
      ],
      derivedStandards: [
        { skillName: 'audit', id: 'confirmed-1', standardKind: 'hard_rule_candidate', status: 'author_confirmed', title: 'Confirmed rule' },
      ],
    });

    const summary = buildStudioDiagnosisSummary(bundle);
    assert.equal(summary.totalCount, 2);
    assert.equal(summary.partial, true);
    assert.equal(summary.bySkill.audit, 2);

    const active = activeStudioDiagnostics(bundle);
    assert.equal(active.length, 1);
    assert.equal(active[0].signal, 'skill_md_not_found');
  });
});

describe('maxLifecycle', () => {
  it('终态(resolved / rejected)优先于自动检出态', () => {
    // 作者确认过的 standard(resolved)不能被新来的自动 detected 信号覆盖掉。
    assert.equal(maxLifecycle('resolved', 'detected'), 'resolved');
    assert.equal(maxLifecycle('detected', 'resolved'), 'resolved');
    assert.equal(maxLifecycle('rejected', 'detected'), 'rejected');
    assert.equal(maxLifecycle('rejected', 'candidate'), 'rejected');
  });

  it('两个终态同时存在时 resolved 胜出', () => {
    assert.equal(maxLifecycle('resolved', 'rejected'), 'resolved');
    assert.equal(maxLifecycle('rejected', 'resolved'), 'resolved');
  });

  it('active 态之间按主动性排序:detected > candidate > confirmed > stale', () => {
    assert.equal(maxLifecycle('detected', 'candidate'), 'detected');
    assert.equal(maxLifecycle('candidate', 'confirmed'), 'candidate');
    assert.equal(maxLifecycle('confirmed', 'stale'), 'confirmed');
  });
});

describe('mergeDiagnosisBundles', () => {
  it('合并相同 stableKey 时累加 occurrenceCount,保留聚合型语义', () => {
    // 两个 bundle 都含同 problemPattern(同 stableKey),分别 occurrenceCount = 3 和 4。
    // 期望合并后 occurrenceCount = 7,不是 occurrences.length = 2。
    const bundleA = buildObserveDiagnostics({
      generatedAt: '2026-05-15T00:00:00.000Z',
      problemPatterns: [{
        skillName: 'audit',
        bucket: 'workflow_mismatch',
        patternKey: 'wf-key',
        signalTypes: ['user_correction'],
        count: 3,
        sessionCount: 2,
      }],
    });
    const bundleB = buildObserveDiagnostics({
      generatedAt: '2026-05-15T00:01:00.000Z',
      problemPatterns: [{
        skillName: 'audit',
        bucket: 'workflow_mismatch',
        patternKey: 'wf-key',
        signalTypes: ['user_correction'],
        count: 4,
        sessionCount: 3,
      }],
    });
    const merged = mergeDiagnosisBundles([bundleA, bundleB]);
    const diag = merged.bySkill.audit.find((d) => d.signal === 'user_correction');
    assert.ok(diag);
    assert.equal(diag.occurrenceCount, 7, '应累加 3 + 4,不是 occurrences.length=2');
    assert.equal(diag.occurrences.length, 2, '源 occurrence 条数确实是 2');
  });

  it('sourceCoverage 用 OR 合并', () => {
    const bundleA = buildObserveDiagnostics({ generatedAt: 't1' });
    const bundleB = buildObserveDiagnostics({ generatedAt: 't2' });
    const merged = mergeDiagnosisBundles([bundleA, bundleB]);
    assert.equal(merged.sourceCoverage.observe, true);
    assert.equal(merged.sourceCoverage.doctor, false);
    assert.equal(merged.sourceCoverage.eval, false);
  });
});

describe('activeStudioDiagnostics — lifecycle 口径', () => {
  it('confirmed / resolved / rejected 都不算 active,跟 Insight 投影口径一致', () => {
    // shared isActiveDiagnosisLifecycle 只放 detected / candidate / stale。
    // 这条 case 防止两个投影口径再分叉。
    const bundle = buildObserveDiagnostics({
      generatedAt: 't',
      derivedStandards: [
        { skillName: 'a', id: 's1', standardKind: 'hard_rule_candidate', status: 'pending_review', title: 'pending(candidate)' },
        { skillName: 'a', id: 's2', standardKind: 'hard_rule_candidate', status: 'author_confirmed', title: 'confirmed(→resolved)' },
        { skillName: 'a', id: 's3', standardKind: 'hard_rule_candidate', status: 'rejected', title: 'rejected' },
      ],
    });
    const active = activeStudioDiagnostics(bundle);
    const titles = active.map((d) => d.title);
    assert.ok(titles.includes('pending(candidate)'), 'candidate 算 active');
    assert.equal(titles.includes('confirmed(→resolved)'), false, 'resolved 不算 active');
    assert.equal(titles.includes('rejected'), false, 'rejected 不算 active');
  });
});
