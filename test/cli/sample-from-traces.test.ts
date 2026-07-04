import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSampleFromTraces } from '../../src/cli/commands/sample.js';
import { reportFileName } from '../../src/eval-core/artifact-file-names.js';
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
});
