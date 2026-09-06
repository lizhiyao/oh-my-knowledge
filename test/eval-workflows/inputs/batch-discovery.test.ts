import { discoverBatchSkills } from '../../../src/eval-workflows/inputs/batch-discovery.js';
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

const MULTI_SKILL_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'multi-skills', 'skills');

describe('discoverBatchSkills canonical sample layout', () => {
  it('只发现带 .omk/eval-samples.{json,yaml} 的目录 skill', () => {
    const entries = discoverBatchSkills(MULTI_SKILL_DIR);
    assert.deepEqual(entries.map((entry) => entry.name), ['classifier', 'summarizer', 'translator']);
    assert.ok(entries.every((entry) => /[/\\]\.omk[/\\]eval-samples\.json$/.test(entry.samplesPath)));
  });

  it('不再把扁平 skill sidecar 当成 batch 私有用例', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-flat-batch-'));
    try {
      writeFileSync(join(root, 'review.md'), '# review\n');
      writeFileSync(join(root, 'review.eval-samples.json'), '{}\n');
      assert.deepEqual(discoverBatchSkills(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
