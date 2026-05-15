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
});
