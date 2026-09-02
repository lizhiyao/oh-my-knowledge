/**
 * 回归:`omk init` 脚手架出来的 eval-samples.json 必须过 omk 自身的**严格**断言合规
 * 校验(load-samples.ts Rule A)。
 *
 * 为什么需要这条:vitest 全局设了 OMK_LENIENT_ASSERTIONS=1(让历史 fixture 继续加载),
 * 于是脚手架里违规的断言(多词 contains / not_contains)在测试里被降级成 warning、悄悄
 * 漏过——而真实用户照「快速开始」跑的第一条 omk eval 是**非 lenient** 的,会直接硬报错。
 * 本测试显式删掉 lenient 开关,在用户实际经历的严格路径上锁住脚手架用例的合规性。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadSamples } from '../../src/inputs/load-samples.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

// 在严格(非 lenient)模式下执行 fn:存档并临时删掉全局的 OMK_LENIENT_ASSERTIONS,
// 复刻真实用户的非 lenient 路径,结束后还原。
function withStrictAssertions(fn: () => void): void {
  const orig = process.env.OMK_LENIENT_ASSERTIONS;
  delete process.env.OMK_LENIENT_ASSERTIONS;
  try { fn(); }
  finally {
    if (orig === undefined) delete process.env.OMK_LENIENT_ASSERTIONS;
    else process.env.OMK_LENIENT_ASSERTIONS = orig;
  }
}

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

      withStrictAssertions(() => {
        // 不抛即为合规：用户照快速开始跑的第一条 omk eval 不会在这里硬报错。
        const result = loadSamples(samplesPath);
        assert.equal(result.samples.length, sampleCount);
      });
    });
  }
});
