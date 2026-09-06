/** `omk init` 生成的样本必须通过评测入口使用的断言校验。 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSamples } from '../../src/eval-workflows/inputs/load-samples.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

describe('omk init scaffold passes strict assertion conformance', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omk-init-conformance-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const sampleCount of [3, 20]) {
    it(`${sampleCount} 条 scaffolded eval-samples.json 在 strict mode 下合规`, () => {
      execFileSync('node', [CLI, 'init', tmpDir, '--samples', String(sampleCount)], { stdio: 'pipe' });
      const samplesPath = join(tmpDir, 'eval-samples.json');

      const result = loadSamples(samplesPath);
      assert.equal(result.samples.length, sampleCount);
    });
  }
});
