import { createWorkflowSampleSetDocument } from '../../../src/eval-workflows/inputs/schemas/sample-set.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { generateTraceDrafts } from '../../../src/eval-workflows/sample-generation/trace-drafts.js';
import { observationReportsDir, observationDraftsDir } from '../../../src/observability/inbox/paths.js';
import { reportFileName } from '../../../src/evidence/storage/file-names.js';

const report = {
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
    };
const sample = { sample_id: 'draft', input: { inputKind: 'text' as const, text: 'Review' }, provenance: 'production-trace' as const };
const options = { model: 'fixture', executorName: 'fixture', noMock: true };
describe('trace 草稿生成用例', () => {
  let root: string;
  let output: string;
  let source: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-trace-drafts-'));
    source = join(observationReportsDir(root), reportFileName('20260507T000000-a111'));
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, JSON.stringify(report));
    output = join(observationDraftsDir(root), 'sample-drafts.json');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it('筛选信号并保留来源，保存草稿但不改动原始观测', async () => {
    const before = readFileSync(source, 'utf8');
    const generate = vi.fn(async () => ({ samples: [sample], costUSD: 0.1 }));
    const result = await generateTraceDrafts({ observationsDir: root, skill: 'wiki', options }, generate);
    expect(result).toEqual({ draftStatus: 'generated', outputPath: output, count: 1, costUSD: 0.1 });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ ...options, items: [expect.objectContaining({ skillName: 'wiki', sourceTrace: '/tmp/trace/session.jsonl' })] }));
    expect(JSON.parse(readFileSync(output, 'utf8')).samples).toEqual(createWorkflowSampleSetDocument([sample]).samples);
    expect(readFileSync(source, 'utf8')).toBe(before);
  });
  it.each(['skill', 'noise'])('没有匹配信号（%s）时不执行生成器', async (mode) => {
    if (mode === 'noise') writeFileSync(source, JSON.stringify({ ...report, items: report.items.map((item) => ({ ...item, severity: 'noise' })) }));
    const generate = vi.fn();
    const result = await generateTraceDrafts({ observationsDir: root, skill: mode === 'skill' ? 'absent' : undefined, options }, generate);
    expect(result).toEqual({ draftStatus: 'no-signals' });
    expect(generate).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });
  it('已有草稿在调用生成器前拒绝', async () => {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, 'existing');
    const generate = vi.fn();
    await expect(generateTraceDrafts({ observationsDir: root, options }, generate)).rejects.toMatchObject({ reason: 'existing-draft' });
    expect(generate).not.toHaveBeenCalled();
    expect(readFileSync(output, 'utf8')).toBe('existing');
  });
  it('生成期间出现外部草稿不覆盖', async () => {
    const generate = vi.fn(async () => {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, 'external');
      return { samples: [sample], costUSD: 0 };
    });
    await expect(generateTraceDrafts({ observationsDir: root, options }, generate)).rejects.toThrow();
    expect(readFileSync(output, 'utf8')).toBe('external');
  });
  it('空结果不落盘', async () => {
    const result = await generateTraceDrafts({ observationsDir: root, options }, async () => ({ samples: [], costUSD: 0.2 }));
    expect(result).toEqual({ draftStatus: 'empty', costUSD: 0.2 });
    expect(existsSync(dirname(output))).toBe(false);
  });
  it('生成结束时取消不写草稿', async () => {
    const cancellation = new AbortController();
    await expect(generateTraceDrafts({ observationsDir: root, options: { ...options, signal: cancellation.signal } }, async () => {
      cancellation.abort();
      return { samples: [sample], costUSD: 0 };
    })).rejects.toThrow();
    expect(existsSync(dirname(output))).toBe(false);
  });
});
