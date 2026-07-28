import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runObserveInbox } from '../../src/cli/commands/observe/inbox.js';
import { reportFileName } from '../../src/eval-core/artifact-file-names.js';

describe('observe CLI', () => {
  it('filters by skill before rendering the by-skill rollup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-observe-cli-'));
    writeFileSync(join(dir, reportFileName('20260507T000000-a111')), JSON.stringify({
      kind: 'observe-inbox',
      schemaVersion: 2,
      meta: {
        tracePath: '/tmp/trace',
        generatedAt: '2026-05-07T00:00:00.000Z',
        segmentCount: 5,
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
          global: false,
          skill: 'audit',
          'include-noise': false,
          'by-skill': true,
          'llm-enhanced-review': false,
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

  it('prints the observe → sample draft command for recyclable signals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-observe-cli-'));
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
        occurrences: 2,
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
          global: false,
          'include-noise': false,
          'by-skill': false,
          'llm-enhanced-review': false,
          refresh: false,
          json: false,
        },
        'zh',
      );
    } finally {
      console.log = originalLog;
    }

    const output = logs.join('\n');
    assert.match(output, /确认高风险或抽样信号后生成评测用例草稿/);
    assert.ok(output.includes(`omk sample --from-traces --observations-dir ${dir}`), output);
  });

  it('prints a skill-scoped sample draft command when inbox is filtered by skill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-observe-cli-'));
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
        id: 'obs-audit',
        skillName: 'audit skill',
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
          global: false,
          skill: 'audit skill',
          'include-noise': false,
          'by-skill': false,
          'llm-enhanced-review': false,
          refresh: false,
          json: false,
        },
        'zh',
      );
    } finally {
      console.log = originalLog;
    }

    const output = logs.join('\n');
    assert.ok(output.includes(`omk sample --from-traces --observations-dir ${dir} --skill 'audit skill'`), output);
  });
});
