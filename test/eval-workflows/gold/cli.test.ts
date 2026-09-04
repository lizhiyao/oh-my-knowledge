import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { initGoldDataset, validateGoldDataset } from '../../../src/eval-workflows/gold/cli.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('gold dataset authoring', () => {
  it('initializes a schema-independent dataset and validates it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omk-gold-'));
    directories.push(directory);
    const files = initGoldDataset(directory, { annotator: 'human-team' });
    assert.equal(files.length, 3);
    assert.match(readFileSync(join(directory, 'metadata.yaml'), 'utf8'), /human-team/);
    assert.match(
      readFileSync(join(directory, 'README.md'), 'utf8'),
      /`omk eval gold compare` 将人工标注与 Core run 观测进行比较。/,
    );
    assert.deepEqual(validateGoldDataset(directory), { ok: true, issues: [], sampleCount: 2 });
  });

  it('refuses to overwrite authored YAML', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omk-gold-'));
    directories.push(directory);
    writeFileSync(join(directory, 'metadata.yaml'), 'metadata: {}');
    assert.throws(() => initGoldDataset(directory), /already contains YAML/);
  });
});
