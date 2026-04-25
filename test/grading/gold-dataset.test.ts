import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGoldDataset } from '../../src/grading/gold-dataset.js';

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

  it('merges multiple annotation files', () => {
    writeYaml('meta.yaml', `metadata: { annotator: human-team, annotatedAt: '2026-04-25', version: '0.2' }`);
    writeYaml('code.yaml', `annotations: [{ sample_id: c1, score: 5 }, { sample_id: c2, score: 2 }]`);
    writeYaml('writing.yaml', `annotations: [{ sample_id: w1, score: 4 }]`);
    const { dataset, issues } = loadGoldDataset(dir);
    assert.equal(issues.length, 0);
    assert.equal(dataset!.annotations.length, 3);
    const ids = dataset!.annotations.map((a) => a.sample_id).sort();
    assert.deepEqual(ids, ['c1', 'c2', 'w1']);
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

  it('rejects missing metadata', () => {
    writeYaml('a.yaml', `annotations: [{ sample_id: x, score: 3 }]`);
    const { dataset, issues } = loadGoldDataset(dir);
    assert.equal(dataset, undefined);
    assert.ok(issues.some((i) => /metadata/.test(i.message)));
  });

  it('rejects non-numeric score with index pointing to the offending entry', () => {
    writeYaml('a.yaml', `
metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1' }
annotations:
  - { sample_id: ok, score: 4 }
  - { sample_id: bad, score: "five" }
`);
    const { issues } = loadGoldDataset(dir);
    const scoreIssue = issues.find((i) => /score/.test(i.message));
    assert.ok(scoreIssue, `expected a score issue, got ${JSON.stringify(issues)}`);
    assert.equal(scoreIssue!.index, 1);
  });

  it('rejects invalid scale', () => {
    writeYaml('a.yaml', `
metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1', scale: { min: 5, max: 1 } }
annotations: [{ sample_id: a, score: 3 }]
`);
    const { issues } = loadGoldDataset(dir);
    assert.ok(issues.some((i) => /scale/.test(i.message)));
  });

  it('returns issues for missing directory without throwing', () => {
    const { dataset, issues } = loadGoldDataset(join(dir, 'does-not-exist'));
    assert.equal(dataset, undefined);
    assert.ok(issues[0].message.includes('not found') || issues[0].message.includes('unreadable'));
  });

  it('reports YAML parse error with line number', () => {
    writeYaml('bad.yaml', `metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1'\nannotations: [unclosed`);
    const { issues } = loadGoldDataset(dir);
    assert.ok(issues.some((i) => /YAML parse error/.test(i.message)),
      `expected YAML parse error, got: ${JSON.stringify(issues)}`);
  });

  it('flags metadata declared in multiple files', () => {
    writeYaml('a.yaml', `metadata: { annotator: x, annotatedAt: '2026-04-25', version: '1' }`);
    writeYaml('b.yaml', `metadata: { annotator: y, annotatedAt: '2026-04-25', version: '1' }
annotations: [{ sample_id: s, score: 1 }]`);
    const { issues } = loadGoldDataset(dir);
    assert.ok(issues.some((i) => /multiple files/.test(i.message)));
  });

  it('handles nested-but-empty directory gracefully', () => {
    mkdirSync(join(dir, 'sub'));
    const { issues } = loadGoldDataset(dir);
    assert.ok(issues.some((i) => /no \.yaml files/.test(i.message)));
  });
});
