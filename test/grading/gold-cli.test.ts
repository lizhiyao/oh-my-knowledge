import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareGoldToReport,
  initGoldDataset,
  validateGoldDataset,
  attachGoldAgreementToReport,
  toPersistedAgreement,
} from '../../src/grading/gold-cli.js';
import { loadGoldDataset } from '../../src/grading/gold-dataset.js';
import type { Report } from '../../src/types/index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omk-gold-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeYaml = (subdir: string, name: string, body: string) => {
  const fullDir = join(dir, subdir);
  mkdirSync(fullDir, { recursive: true });
  writeFileSync(join(fullDir, name), body);
};

const buildReport = (
  variant: string,
  scoresById: Record<string, number>,
  judgeModel = 'claude-sonnet-4-6',
): Report => ({
  id: 'r1',
  meta: {
    variants: [variant],
    model: 'claude-sonnet-4-6',
    judgeModel,
    executor: 'claude',
    sampleCount: Object.keys(scoresById).length,
    taskCount: Object.keys(scoresById).length,
    totalCostUSD: 0,
    timestamp: '2026-04-25T00:00:00Z',
    cliVersion: 'test',
    nodeVersion: 'test',
    artifactHashes: { [variant]: 'abc' },
  },
  summary: {},
  results: Object.entries(scoresById).map(([sample_id, llmScore]) => ({
    sample_id,
    variants: {
      [variant]: {
        ok: true, durationMs: 0, durationApiMs: 0, inputTokens: 0, outputTokens: 0,
        totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        execCostUSD: 0, judgeCostUSD: 0, costUSD: 0, numTurns: 0,
        llmScore,
        outputPreview: null,
      },
    },
  })),
});

describe('compareGoldToReport', () => {
  it('returns α=1 when judge matches gold exactly across multiple samples', () => {
    writeYaml('ds', 'm.yaml', `metadata: { annotator: human-team, annotatedAt: '2026-04-25', version: '1' }`);
    writeYaml('ds', 'a.yaml', `annotations:
  - { sample_id: s1, score: 4 }
  - { sample_id: s2, score: 3 }
  - { sample_id: s3, score: 5 }`);
    const { dataset } = loadGoldDataset(join(dir, 'ds'));
    assert.ok(dataset);
    const report = buildReport('control', { s1: 4, s2: 3, s3: 5 });
    const result = compareGoldToReport({ report, gold: dataset!, samples: 200, seed: 1 });
    assert.equal(result.agreement.alpha, 1);
    assert.equal(result.agreement.sampleCount, 3);
    assert.equal(result.missing.length, 0);
    assert.equal(result.contaminationWarning, undefined);
  });

  it('reports missing sample_ids from the report', () => {
    writeYaml('ds', 'm.yaml', `metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1' }`);
    writeYaml('ds', 'a.yaml', `annotations:
  - { sample_id: present, score: 4 }
  - { sample_id: absent_from_report, score: 2 }`);
    const { dataset } = loadGoldDataset(join(dir, 'ds'));
    const report = buildReport('v1', { present: 4 });
    const result = compareGoldToReport({ report, gold: dataset!, samples: 100, seed: 1 });
    assert.equal(result.agreement.sampleCount, 1);
    assert.deepEqual(result.missing, ['absent_from_report']);
  });

  it('emits contamination warning when annotator id matches judge model id', () => {
    writeYaml('ds', 'm.yaml', `metadata: { annotator: claude-sonnet-4-6, annotatedAt: '2026-04-25', version: '1' }`);
    writeYaml('ds', 'a.yaml', `annotations: [{ sample_id: s1, score: 4 }]`);
    const { dataset } = loadGoldDataset(join(dir, 'ds'));
    const report = buildReport('v1', { s1: 4 }, 'claude-sonnet-4-6');
    const result = compareGoldToReport({ report, gold: dataset!, samples: 100, seed: 1 });
    assert.ok(result.contaminationWarning);
    assert.match(result.contaminationWarning!, /sonnet/i);
  });

  it('no contamination warning when annotator differs from judge', () => {
    writeYaml('ds', 'm.yaml', `metadata: { annotator: claude-opus-4-7, annotatedAt: '2026-04-25', version: '1' }`);
    writeYaml('ds', 'a.yaml', `annotations: [{ sample_id: s1, score: 4 }]`);
    const { dataset } = loadGoldDataset(join(dir, 'ds'));
    const report = buildReport('v1', { s1: 4 }, 'claude-sonnet-4-6');
    const result = compareGoldToReport({ report, gold: dataset!, samples: 100, seed: 1 });
    assert.equal(result.contaminationWarning, undefined);
  });

  it('throws when report has no variants', () => {
    writeYaml('ds', 'm.yaml', `metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1' }`);
    writeYaml('ds', 'a.yaml', `annotations: [{ sample_id: s1, score: 4 }]`);
    const { dataset } = loadGoldDataset(join(dir, 'ds'));
    const report = buildReport('v1', {});
    report.meta.variants = [];
    assert.throws(() => compareGoldToReport({ report, gold: dataset!, samples: 100, seed: 1 }));
  });

  it('respects a non-default variant', () => {
    writeYaml('ds', 'm.yaml', `metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1' }`);
    writeYaml('ds', 'a.yaml', `annotations: [{ sample_id: s1, score: 5 }]`);
    const { dataset } = loadGoldDataset(join(dir, 'ds'));
    // Build a report with two variants where only "treatment" agrees.
    const base = buildReport('control', { s1: 1 });
    base.meta.variants = ['control', 'treatment'];
    base.results[0].variants.treatment = { ...base.results[0].variants.control, llmScore: 5 };
    const result = compareGoldToReport({ report: base, gold: dataset!, variant: 'treatment', samples: 100, seed: 1 });
    assert.equal(result.agreement.alpha, NaN); // single sample, no variance — undefined
    assert.equal(result.rows[0].judgeScore, 5);
    assert.equal(result.variant, 'treatment');
  });
});

describe('initGoldDataset', () => {
  it('creates metadata.yaml + annotations.yaml + README.md', () => {
    const out = join(dir, 'new');
    const written = initGoldDataset(out, { annotator: 'tester' });
    assert.equal(written.length, 3);
    const files = readdirSync(out).sort();
    assert.deepEqual(files, ['README.md', 'annotations.yaml', 'metadata.yaml']);
    const meta = readFileSync(join(out, 'metadata.yaml'), 'utf-8');
    assert.match(meta, /annotator: tester/);
  });

  it('refuses to clobber existing yaml files', () => {
    writeYaml('keep', 'existing.yaml', 'foo: bar');
    assert.throws(() => initGoldDataset(join(dir, 'keep')), /already contains YAML files/);
  });
});

describe('attachGoldAgreementToReport', () => {
  it('mutates report.meta.humanAgreement and writes the report file', () => {
    writeYaml('ds', 'm.yaml', `metadata: { annotator: claude-opus-4-7, annotatedAt: '2026-04-25', version: '0.1' }`);
    writeYaml('ds', 'a.yaml', `annotations:
  - { sample_id: s1, score: 4 }
  - { sample_id: s2, score: 3 }
  - { sample_id: s3, score: 5 }`);
    const report = buildReport('control', { s1: 4, s2: 3, s3: 5 });
    const outDir = join(dir, 'reports');
    mkdirSync(outDir, { recursive: true });
    const out = attachGoldAgreementToReport({
      report,
      goldDir: join(dir, 'ds'),
      outputDir: outDir,
      samples: 100,
      seed: 1,
    });
    assert.ok(out.result);
    assert.equal(report.meta.humanAgreement?.alpha, 1);
    assert.equal(report.meta.humanAgreement?.goldAnnotator, 'claude-opus-4-7');
    // Report file must exist on disk after re-persist.
    const filePath = join(outDir, `${report.id}.json`);
    const persisted = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.equal(persisted.meta.humanAgreement.alpha, 1);
  });

  it('returns load issues when gold dir is missing', () => {
    const report = buildReport('v1', { s1: 4 });
    const outDir = join(dir, 'reports');
    mkdirSync(outDir, { recursive: true });
    const out = attachGoldAgreementToReport({
      report,
      goldDir: join(dir, 'does-not-exist'),
      outputDir: outDir,
    });
    assert.equal(out.result, undefined);
    assert.ok(out.loadIssues.length > 0);
    assert.equal(report.meta.humanAgreement, undefined);
  });
});

describe('toPersistedAgreement', () => {
  it('strips the comparison rows and keeps only the persistable fields', () => {
    writeYaml('ds', 'm.yaml', `metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1' }`);
    writeYaml('ds', 'a.yaml', `annotations: [{ sample_id: s1, score: 4 }]`);
    const { dataset } = loadGoldDataset(join(dir, 'ds'));
    const report = buildReport('v1', { s1: 4, s2: 3 });
    const result = compareGoldToReport({ report, gold: dataset!, samples: 100, seed: 1 });
    const persisted = toPersistedAgreement(result, dataset!);
    assert.equal(persisted.goldAnnotator, 'x');
    assert.equal(persisted.goldVersion, '1');
    // No `rows` field on the persisted shape.
    assert.equal((persisted as unknown as Record<string, unknown>).rows, undefined);
  });
});

describe('validateGoldDataset', () => {
  it('returns ok=true for a clean dataset', () => {
    writeYaml('ds', 'm.yaml', `metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1' }`);
    writeYaml('ds', 'a.yaml', `annotations: [{ sample_id: s1, score: 4 }]`);
    const r = validateGoldDataset(join(dir, 'ds'));
    assert.equal(r.ok, true);
    assert.equal(r.sampleCount, 1);
  });

  it('returns ok=false with messages for broken dataset', () => {
    writeYaml('ds', 'a.yaml', `annotations: [{ sample_id: s1, score: 4 }]`);
    // missing metadata file
    const r = validateGoldDataset(join(dir, 'ds'));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((m) => /metadata/.test(m)));
  });
});
