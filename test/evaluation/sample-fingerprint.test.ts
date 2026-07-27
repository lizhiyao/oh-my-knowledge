import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import {
  hashSample,
  hashSampleExecutionDependencies,
} from '../../src/eval-core/sample-fingerprint.js';
import type { Sample } from '../../src/types/index.js';

describe('sample fingerprint', () => {
  it('mock return_file 内容变化同时使执行缓存和报告样本指纹失效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-sample-fingerprint-'));
    try {
      const fixturePath = join(dir, 'fixture.txt');
      const sample: Sample = {
        sample_id: 'mock-fixture',
        prompt: 'read fixture',
        mocks: [{ tool: 'Read', return_file: 'fixture.txt' }],
      };
      writeFileSync(fixturePath, 'v1');
      const executionBefore = hashSampleExecutionDependencies(sample, dir);
      const reportBefore = hashSample(sample, dir);

      writeFileSync(fixturePath, 'v2');
      assert.notEqual(hashSampleExecutionDependencies(sample, dir), executionBefore);
      assert.notEqual(hashSample(sample, dir), reportBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('custom assertion 模块只改变评分契约，不改变执行缓存契约', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-sample-fingerprint-'));
    try {
      const assertionPath = join(dir, 'assertion.mjs');
      const sample = {
        sample_id: 'custom-assertion',
        prompt: 'produce output',
        assertions: [{ type: 'custom', fn: 'assertion.mjs' }],
      } as Sample;
      writeFileSync(assertionPath, 'export default () => true;');
      const executionBefore = hashSampleExecutionDependencies(sample, dir);
      const reportBefore = hashSample(sample, dir);

      writeFileSync(assertionPath, 'export default () => false;');
      assert.equal(hashSampleExecutionDependencies(sample, dir), executionBefore);
      assert.notEqual(hashSample(sample, dir), reportBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('custom assertion 的静态本地 import 内容进入报告样本指纹', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-sample-fingerprint-'));
    try {
      writeFileSync(
        join(dir, 'assertion.mjs'),
        'import { check } from "./helper.mjs"; export default check;',
      );
      const helperPath = join(dir, 'helper.mjs');
      const sample = {
        sample_id: 'custom-assertion-import',
        prompt: 'produce output',
        assertions: [{ type: 'custom', fn: 'assertion.mjs' }],
      } as Sample;
      writeFileSync(helperPath, 'export const check = () => ({ pass: true });');
      const before = hashSample(sample, dir);
      writeFileSync(helperPath, 'export const check = () => ({ pass: false });');
      assert.notEqual(hashSample(sample, dir), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同一断言依赖图不受 checkout 绝对路径影响', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-sample-fingerprint-portable-'));
    const first = join(root, 'a', 'samples');
    const second = join(root, 'b', 'samples');
    try {
      const sample = {
        sample_id: 'portable-custom-assertion',
        prompt: 'produce output',
        assertions: [{ type: 'custom', fn: 'assertion.mjs' }],
      } as Sample;
      for (const dir of [first, second]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'assertion.mjs'),
          'import { check } from "../shared-check.mjs"; export default check;',
        );
        writeFileSync(
          join(dir, '..', 'shared-check.mjs'),
          'export const check = () => ({ pass: true });',
        );
      }
      assert.equal(hashSample(sample, first), hashSample(sample, second));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('依赖文件从缺失变为存在时指纹变化', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-sample-fingerprint-'));
    try {
      const sample: Sample = {
        sample_id: 'missing-fixture',
        prompt: 'read fixture',
        mocks: [{ tool: 'Read', return_file: 'late.txt' }],
      };
      const before = hashSample(sample, dir);
      writeFileSync(join(dir, 'late.txt'), 'now present');
      assert.notEqual(hashSample(sample, dir), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
