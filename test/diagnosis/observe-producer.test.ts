import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildObserveDiagnosticsFromReport } from '../../src/diagnosis/observe-producer.js';
import type { ObservationInboxReport } from '../../src/observability/inbox.js';

describe('buildObserveDiagnosticsFromReport', () => {
  it('uses real observe skill-chain, runtime checks, patterns, and rule findings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-observe-diagnosis-'));
    try {
      const skillDir = join(dir, 'skills', 'audit');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
hardRules:
  - id: read-domain
    rule: 必须读取领域知识文件
    expectedBehavior: 使用 Read 读取 domain 文件
workflows:
  - id: main
    nodes:
      - id: upload
        action: 上传产物
---

# audit
`);
      const report = {
        kind: 'observe-inbox',
        schemaVersion: 1,
        meta: {
          tracePath: '/tmp/synthetic-trace',
          generatedAt: '2026-05-15T00:00:00.000Z',
          segmentCount: 1,
          itemCount: 0,
          skillInvocationCounts: { audit: 1 },
          skillSessionCounts: { audit: 1 },
        },
        items: [],
        experience: {
          kind: 'observe-experience',
          schemaVersion: 1,
          scope: 'evidence-only',
          generatedAt: '2026-05-15T00:00:00.000Z',
          meta: {
            sessionCount: 1,
            skillCount: 1,
            invocationCount: 1,
            goalSliceCount: 1,
            noteCodes: ['no_llm_judge', 'deterministic_assistive_inference'],
          },
          goalSlices: [],
          invocations: [{
            skillName: 'audit',
            toolCounts: { Read: 1 },
            indicators: { toolCallCount: 1, toolFailureCount: 0 },
            timeline: [
              { id: 'e1', kind: 'tool_use', sourceTrace: '/tmp/synthetic.jsonl', sessionId: 's1', order: 1, toolName: 'Read', label: 'tool_use Read', snippet: '{"file_path":"domain.md"}' },
            ],
          }],
          sessions: [],
          skills: [{
            skillName: 'audit',
            invocationCount: 1,
            sessionCount: 1,
            sourceKinds: ['claude'],
            entrypoints: [],
            entrypointCounts: {},
            sourceMetadataCounts: { channels: {}, senders: {}, aimaCommands: {}, providers: {}, models: {} },
            attributionCounts: {},
            pluginNames: [],
            rawSkillRefs: [],
            commandNames: [],
            toolCounts: { Read: 1 },
            firstSeen: '2026-05-15T00:00:00.000Z',
            lastSeen: '2026-05-15T00:01:00.000Z',
            reviewFirstSessionCount: 1,
            sampleReviewSessionCount: 0,
            indicators: {
              userMessageCount: 1,
              userFollowUpCount: 0,
              userCorrectionCount: 1,
              userInterruptionCount: 0,
              negativeFeedbackCount: 0,
              positiveFeedbackCount: 0,
              userGoalShiftCount: 0,
              hardRuleTextHitCount: 0,
              assistantDeliverySignalCount: 0,
              toolCallCount: 1,
              toolFailureCount: 0,
              highObservationCount: 0,
              mediumObservationCount: 0,
              hedgingCount: 0,
              explicitMarkerCount: 0,
            },
            evidenceChain: {
              userMessageCount: 1,
              runtimeContextCount: 0,
              skillContextCount: 0,
              assistantMessageCount: 0,
              toolUseCount: 1,
              toolResultCount: 0,
              toolFailureResultCount: 0,
              observationCount: 0,
            },
            ruleFindings: [{
              code: 'user_correction_seen',
              level: 'attention',
              count: 1,
              evidenceRefs: [{ id: 'u1', kind: 'user_message', sourceTrace: '/tmp/synthetic.jsonl', sessionId: 's1', messageIndex: 1, snippet: '不对，重新生成' }],
            }],
            assistiveInference: {
              mode: 'deterministic_rules_only',
              code: 'review_recommended',
              confidence: 'high',
              basisRuleCodes: ['user_correction_seen'],
              cautionCodes: ['no_llm_judge', 'rule_only'],
              evidenceRefs: [],
            },
            problemPatterns: [{
              id: 'p1',
              bucket: 'workflow_mismatch',
              patternKey: 'workflow_mismatch:user_correction',
              count: 2,
              sessionCount: 1,
              recentSessionIds: ['s1'],
              signalTypes: ['user_correction'],
              evidenceRefs: [{ id: 'u1', kind: 'user_message', sourceTrace: '/tmp/synthetic.jsonl', sessionId: 's1', messageIndex: 1, snippet: '不对，重新生成' }],
              lastSeen: '2026-05-15T00:01:00.000Z',
            }],
            relatedObservationIds: [],
          }],
        },
      } as unknown as ObservationInboxReport;

      const bundle = buildObserveDiagnosticsFromReport(report, { cwd: dir });
      const signals = bundle.bySkill.audit.map((item) => item.signal);
      assert.ok(signals.includes('runtime_workflow_review'));
      assert.ok(signals.includes('user_correction'));
      assert.ok(signals.includes('user_correction_seen'));
      assert.equal(bundle.sourceCoverage.observe, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未传 cwd 时按 inbox items[].cwd 推断每个 skill 的 cwd,跨项目场景下不误报 skill_md_not_found', () => {
    // 模拟 `omk observe ingest /path/to/B-traces`:用户在 A 目录跑命令,trace 来自 B 项目。
    // build 路径以前用 process.cwd() = A,A 下没有 skills/audit/SKILL.md,会产出 `skill_md_not_found`
    // 假阳性并持久化进 inbox JSON。改成从 inbox items[].cwd 按 skill 推断后,应该用 B 目录的
    // SKILL.md 正确解析。
    const projectB = mkdtempSync(join(tmpdir(), 'omk-project-b-'));
    const projectA = mkdtempSync(join(tmpdir(), 'omk-project-a-'));
    try {
      mkdirSync(join(projectB, 'skills', 'audit'), { recursive: true });
      writeFileSync(join(projectB, 'skills', 'audit', 'SKILL.md'), `---
hardRules:
  - id: r1
    rule: must read domain
    expectedBehavior: use Read
---

# audit
`);
      const origCwd = process.cwd();
      process.chdir(projectA);  // 模拟在 projectA 跑 ingest
      try {
        const report = {
          kind: 'observe-inbox',
          schemaVersion: 1,
          meta: {
            tracePath: '/tmp/trace-b',
            generatedAt: '2026-05-15T00:00:00.000Z',
            segmentCount: 1,
            itemCount: 1,
            skillInvocationCounts: { audit: 1 },
            skillSessionCounts: { audit: 1 },
          },
          items: [{
            id: 'obs-1', skillName: 'audit', artifactVersion: 'unknown',
            cwd: projectB,  // 关键:item 记录了 trace 的原始 cwd
            sessionId: 's1', sourceTrace: '/tmp/trace-b/s1.jsonl', sourceKind: 'claude',
            signalType: 'failed_search', signalSubtype: 'hard_miss',
            confidence: 0.9, attributionConfidence: 0.85, severity: 'high',
            evidence: {}, firstSeen: '2026-05-15T00:00:00.000Z', lastSeen: '2026-05-15T00:00:00.000Z',
            occurrences: 1, recentSessionIds: ['s1'], representativeEvidence: [],
          }],
        } as unknown as ObservationInboxReport;
        const bundle = buildObserveDiagnosticsFromReport(report);
        const signals = (bundle.bySkill.audit ?? []).map((item) => item.signal);
        assert.equal(
          signals.includes('skill_md_not_found'), false,
          `不应产生 skill_md_not_found 假阳性(应该用 ${projectB} 找到 SKILL.md)`,
        );
      } finally {
        process.chdir(origCwd);
      }
    } finally {
      rmSync(projectB, { recursive: true, force: true });
      rmSync(projectA, { recursive: true, force: true });
    }
  });

  it('未传 cwd 且 inbox 同 skill 出现多个 cwd 时跳过 chain advisory,避免任意挑一个误报', () => {
    // skill 在多个 cwd 都被调用过,无法确定权威路径。保守做法:跳过该 skill 的
    // skill_md_not_found / hardrules_not_declared 等 chain advisory,只保留 problemPatterns 等
    // 跟 cwd 无关的诊断。
    const report = {
      kind: 'observe-inbox',
      schemaVersion: 1,
      meta: {
        tracePath: '/tmp/trace',
        generatedAt: '2026-05-15T00:00:00.000Z',
        segmentCount: 2,
        itemCount: 2,
        skillInvocationCounts: { audit: 2 },
        skillSessionCounts: { audit: 2 },
      },
      items: [
        { id: 'o1', skillName: 'audit', cwd: '/repo-x', sessionId: 's1', sourceTrace: '/t', sourceKind: 'claude',
          signalType: 'failed_search', signalSubtype: 'hard_miss', confidence: 0.9,
          attributionConfidence: 0.85, severity: 'high', evidence: {},
          firstSeen: 't', lastSeen: 't', occurrences: 1, recentSessionIds: ['s1'], representativeEvidence: [] },
        { id: 'o2', skillName: 'audit', cwd: '/repo-y', sessionId: 's2', sourceTrace: '/t', sourceKind: 'claude',
          signalType: 'failed_search', signalSubtype: 'hard_miss', confidence: 0.9,
          attributionConfidence: 0.85, severity: 'high', evidence: {},
          firstSeen: 't', lastSeen: 't', occurrences: 1, recentSessionIds: ['s2'], representativeEvidence: [] },
      ],
    } as unknown as ObservationInboxReport;
    const bundle = buildObserveDiagnosticsFromReport(report);
    const signals = (bundle.bySkill.audit ?? []).map((item) => item.signal);
    assert.equal(
      signals.includes('skill_md_not_found'), false,
      '多 cwd ambiguous 时应跳过 chain advisory',
    );
    assert.equal(
      signals.includes('hardrules_not_declared'), false,
      '多 cwd ambiguous 时也不发 hardrules_not_declared',
    );
  });
});
