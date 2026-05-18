import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runObserveInbox } from '../../src/cli/commands/observe/inbox.js';

describe('observe CLI', () => {
  it('filters by skill before rendering the by-skill rollup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-observe-cli-'));
    writeFileSync(join(dir, '2026-05-07T00-00-00-observe-inbox.json'), JSON.stringify({
      kind: 'observe-inbox',
      schemaVersion: 1,
      meta: {
        tracePath: '/tmp/trace',
        generatedAt: '2026-05-07T00:00:00.000Z',
        segmentCount: 2,
        itemCount: 1,
        skillInvocationCounts: { audit: 2, wiki: 3 },
        skillSessionCounts: { audit: 1, wiki: 2 },
        skillInvocationLastSeen: { audit: '2026-05-07T00:00:00.000Z', wiki: '2026-05-07T00:01:00.000Z' },
      },
      items: [{
        id: 'obs-audit',
        skillName: 'audit',
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

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => { logs.push(String(value)); };
    try {
      await runObserveInbox(
        {},
        {
          lang: 'zh',
          'input-dir': dir,
          skill: 'audit',
          'include-noise': false,
          'by-skill': true,
          'soft-standard-extract': false,
          refresh: false,
          json: true,
        },
        'zh',
      );
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(logs.join('\n')) as { rows: Array<{ skillName: string }> };
    assert.deepEqual(output.rows.map((row) => row.skillName), ['audit']);
  });
});
