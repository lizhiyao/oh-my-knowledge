import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSampleFromTraces } from '../../src/cli/commands/sample.js';
import { generateSamplesFromTraces } from '../../src/authoring/generator.js';
import { reportFileName } from '../../src/eval-core/artifact-file-names.js';
import {
  buildObservationInboxReport,
  saveObservationInboxReport,
} from '../../src/observability/inbox.js';
import { buildKnowledgeDebuggerViewModel } from '../../src/observability/knowledge-debugger.js';
import { updateObservationReviewState } from '../../src/observability/review-state.js';
import { withCapturedStderr } from '../helpers/stderr.js';

describe('sample --from-traces', () => {
  it('filters observe inbox signals by --skill before drafting samples', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-sample-from-traces-'));
    writeFileSync(join(dir, reportFileName('20260507T000000-a111')), JSON.stringify({
      kind: 'observe-inbox',
      schemaVersion: 2,
      meta: {
        tracePath: '/tmp/trace',
        generatedAt: '2026-05-07T00:00:00.000Z',
        segmentCount: 1,
        itemCount: 1,
      },
      items: [{
        id: 'obs-wiki',
        skillName: 'wiki',
        artifactVersion: 'unknown',
        cwd: '/repo',
        sessionId: 's1',
        sourceTrace: '/tmp/trace/session.jsonl',
        sourceKind: 'claude',
        signalType: 'failed_search',
        signalSubtype: 'hard_miss',
        confidence: 0.9,
        attributionConfidence: 0.85,
        severity: 'high',
        severityReasonCode: 'knowledge_gap_suspected',
        evidence: { tool: 'Grep', query: 'schema' },
        firstSeen: '2026-05-07T00:00:00.000Z',
        lastSeen: '2026-05-07T00:00:00.000Z',
        occurrences: 1,
        recentSessionIds: ['s1'],
        representativeEvidence: [{ tool: 'Grep', query: 'schema' }],
      }],
    }, null, 2));

    const { stderr } = await withCapturedStderr(async () => {
      await runSampleFromTraces({
        lang: 'zh',
        batch: false,
        model: 'sonnet',
        executor: 'test-executor',
        'skill-dir': 'skills',
        append: false,
        'no-mock': false,
        fix: false,
        'from-traces': true,
        'observations-dir': dir,
        skill: 'audit',
      }, 'zh');
    });

    assert.match(stderr, /audit 没有可回流的失败信号/);
    assert.equal(existsSync(join(dir, 'sample-drafts.json')), false);
  });

  it('generates a draft linked to one user-confirmed Knowledge Gap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-sample-from-gap-'));
    const observationsDir = join(root, 'observations');
    const tracePath = join(root, 'codex-failure.jsonl');
    writeFileSync(
      tracePath,
      readFileSync(new URL('../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url), 'utf-8'),
    );
    const report = buildObservationInboxReport(tracePath);
    saveObservationInboxReport(report, observationsDir);
    const session = report.experience?.sessions[0];
    assert.ok(session);
    const evidence = buildKnowledgeDebuggerViewModel(session).knowledgeEvidence
      .find((item) => item.knowledgeKind === 'skill');
    assert.ok(evidence);
    const gapId = 'knowledge-gap:release-gate';
    updateObservationReviewState(observationsDir, {
      targetType: 'knowledge_gap',
      targetId: gapId,
      verdict: 'real_issue',
      gapKind: 'missing',
      note: '发布前缺少评测门禁。',
      candidateKnowledge: '发布前必须先运行 omk doctor 和 omk eval。',
      knowledgeEvidenceId: evidence.id,
      experienceSessionId: session.id,
      sessionId: session.sessionId,
      sourceTrace: session.sourceTrace,
    }, '2026-08-03T00:01:00.000Z');

    await runSampleFromTraces({
      lang: 'zh',
      batch: false,
      model: 'test-model',
      executor: 'codex',
      'skill-dir': 'skills',
      append: false,
      'no-mock': false,
      fix: false,
      'from-traces': true,
      'observations-dir': observationsDir,
      gap: gapId,
    }, 'zh', {
      generateSamplesFromTraces: (options) => generateSamplesFromTraces({
        ...options,
        executor: async (input) => {
          assert.match(input.prompt, /missing doctor\/eval evidence/);
          assert.match(input.prompt, /不对，发布失败了/);
          return {
            ok: true,
            output: JSON.stringify([{
              sample_id: 'release-gate-1',
              prompt: '检查并发布当前版本。',
              rubric: '发布前应先检查 doctor 和 eval 证据。',
            }]),
            durationMs: 1,
            durationApiMs: 1,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUSD: 0,
            stopReason: 'end_turn',
            numTurns: 1,
          };
        },
      }),
    });

    const drafts = JSON.parse(readFileSync(join(observationsDir, 'sample-drafts.json'), 'utf-8'));
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].provenance, 'production-trace');
    assert.equal(drafts[0].sourceRefs[0].sourceType, 'knowledge_gap');
    assert.equal(drafts[0].sourceRefs[0].sourceId, gapId);
    assert.equal(drafts[0].sourceRefs[0].experienceSessionId, session.id);
    assert.equal(drafts[0].sourceRefs[0].knowledgeEvidenceId, evidence.id);
    assert.equal(drafts[0].sourceRefs[0].sourceTrace, session.sourceTrace);
  });
});
