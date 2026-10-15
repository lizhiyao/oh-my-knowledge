import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGoldDataset } from '../../../src/eval-workflows/gold/dataset.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omk-gold-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeYaml = (name: string, body: string) => writeFileSync(join(dir, name), body);

describe('loadGoldDataset', () => {
  it('loads a single-file dataset cleanly', () => {
    writeYaml('all.yaml', `
metadata:
  annotator: claude-opus-4-7
  annotatedAt: '2026-04-25'
  version: '0.1'
annotations:
  - sample_id: a1
    score: 4
  - sample_id: a2
    score: 3
    reason: "borderline"
`);
    const { dataset, issues } = loadGoldDataset(dir);
    assert.equal(issues.length, 0);
    assert.ok(dataset);
    assert.equal(dataset!.metadata.annotator, 'claude-opus-4-7');
    assert.equal(dataset!.annotations.length, 2);
    assert.equal(dataset!.annotations[1].reason, 'borderline');
  });

  it('merges annotation files before validating their declared scale', () => {
    writeYaml('meta.yaml', `metadata: { annotator: human-team, annotatedAt: '2026-04-25', version: '0.2', scale: { min: 0, max: 1 } }`);
    writeYaml('code.yaml', `annotations: [{ sample_id: c1, score: 1 }, { sample_id: c2, score: 0 }]`);
    writeYaml('writing.yaml', `annotations: [{ sample_id: w1, score: 0.5 }]`);
    const { dataset, issues } = loadGoldDataset(dir);
    assert.equal(issues.length, 0);
    assert.equal(dataset!.annotations.length, 3);
    const ids = dataset!.annotations.map((a) => a.sample_id).sort();
    assert.deepEqual(ids, ['c1', 'c2', 'w1']);
    writeYaml('writing.yaml', `annotations: [{ sample_id: w1, score: 2 }]`);
    const invalid = loadGoldDataset(dir);
    assert.deepEqual(invalid.dataset?.annotations.map((annotation) => annotation.sample_id), ['c1', 'c2', 'w1']);
    assert.equal(invalid.dataset?.annotations[2].score, 2);
    assert.ok(invalid.issues.some((issue) => issue.path.endsWith('writing.yaml')
      && issue.index === 0 && /\[0, 1\]/.test(issue.message)));
  });

  it('reports duplicate sample_ids without crashing', () => {
    writeYaml('a.yaml', `
metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1' }
annotations:
  - { sample_id: dup, score: 3 }
  - { sample_id: dup, score: 5 }
`);
    const { dataset, issues } = loadGoldDataset(dir);
    assert.equal(dataset!.annotations.length, 1);
    assert.ok(issues.some((i) => /duplicate sample_id/.test(i.message)));
  });

  it('returns issues for missing directory without throwing', () => {
    const { dataset, issues } = loadGoldDataset(join(dir, 'does-not-exist'));
    assert.equal(dataset, undefined);
    assert.ok(issues[0].message.includes('not found') || issues[0].message.includes('unreadable'));
  });

  const invalidDatasetCases = [
    {
      name: 'missing metadata',
      setup: () => writeYaml('a.yaml', `annotations: [{ sample_id: x, score: 3 }]`),
      check: (issues: ReturnType<typeof loadGoldDataset>['issues'], dataset: ReturnType<typeof loadGoldDataset>['dataset']) => {
        assert.equal(dataset, undefined);
        assert.ok(issues.some((i) => /metadata/.test(i.message)));
      },
    },
    {
      name: 'non-numeric and out-of-scale scores',
      setup: () => writeYaml('a.yaml', `
metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1' }
annotations:
  - { sample_id: ok, score: 4 }
  - { sample_id: bad, score: "five" }
  - { sample_id: high, score: 6 }
  - { sample_id: low, score: 0 }
`),
      check: (issues: ReturnType<typeof loadGoldDataset>['issues']) => {
        const scoreIssue = issues.find((i) => /score/.test(i.message));
        assert.ok(scoreIssue, `expected a score issue, got ${JSON.stringify(issues)}`);
        assert.equal(scoreIssue!.index, 1);
        assert.ok(issues.some((issue) => issue.index === 2 && /\[1, 5\]/.test(issue.message)));
        assert.ok(issues.some((issue) => issue.index === 3 && /\[1, 5\]/.test(issue.message)));
      },
    },
    {
      name: 'invalid scale',
      setup: () => writeYaml('a.yaml', `
metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1', scale: { min: 5, max: 1 } }
annotations: [{ sample_id: a, score: 3 }]
`),
      check: (issues: ReturnType<typeof loadGoldDataset>['issues']) => {
        assert.ok(issues.some((i) => /scale/.test(i.message)));
        for (const scale of ['null', '{ min: .nan, max: 5 }', '{ min: 1, max: .inf }']) {
          writeYaml('a.yaml', `metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1', scale: ${scale} }\nannotations: [{ sample_id: a, score: 3 }]`);
          assert.ok(loadGoldDataset(dir).issues.some((issue) => /scale/.test(issue.message)));
        }
      },
    },
    {
      name: 'YAML parse error',
      setup: () => writeYaml('bad.yaml', `metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1'\nannotations: [unclosed`),
      check: (issues: ReturnType<typeof loadGoldDataset>['issues']) => {
        assert.ok(issues.some((i) => /YAML parse error/.test(i.message)),
          `expected YAML parse error, got: ${JSON.stringify(issues)}`);
      },
    },
    {
      name: 'metadata declared in multiple files',
      setup: () => {
        writeYaml('a.yaml', `metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1' }`);
        writeYaml('b.yaml', `metadata: { annotator: y, annotatedAt: '2026-04-25', version: '1' }
annotations: [{ sample_id: s, score: 1 }]`);
      },
      check: (issues: ReturnType<typeof loadGoldDataset>['issues']) => {
        assert.ok(issues.some((i) => /multiple files/.test(i.message)));
      },
    },
    {
      name: 'nested-but-empty directory',
      setup: () => mkdirSync(join(dir, 'sub')),
      check: (issues: ReturnType<typeof loadGoldDataset>['issues']) => {
        assert.ok(issues.some((i) => /no \.yaml files/.test(i.message)));
      },
    },
  ];

  it.each(invalidDatasetCases)('reports invalid dataset shape: $name', ({ setup, check }) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    setup();
    const { dataset, issues } = loadGoldDataset(dir);
    check(issues, dataset);
  });
});
