import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSamples } from '../../../src/eval-workflows/inputs/load-samples.js';
import type { Assertion } from '../../../src/eval-workflows/inputs/contracts/assertion.js';
import type { Sample } from '../../../src/eval-workflows/inputs/contracts/sample.js';
import { PROJECT_ROOT, runCli } from '../../helpers/cli-process.js';

const HAN_RE = /\p{Script=Han}/u;

function collectEvalSampleFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectEvalSampleFiles(fullPath));
      continue;
    }
    if (/(\.|^)eval-samples\.(json|ya?ml)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function collectAssertionViolations(source: string, samples: Sample[]): string[] {
  const violations: string[] = [];
  for (const sample of samples) {
    visitAssertions(source, sample.sample_id, sample.assertions ?? [], 'assertions', violations);
  }
  return violations;
}

function visitAssertions(
  source: string,
  sampleId: string,
  assertions: Assertion[],
  path: string,
  violations: string[],
): void {
  for (const [index, assertion] of assertions.entries()) {
    const assertionPath = `${path}[${index}]`;
    for (const key of ['value', 'pattern', 'reference'] as const) {
      const value = assertion[key];
      if (typeof value === 'string' && HAN_RE.test(value)) {
        violations.push(`${source}:${sampleId}:${assertionPath}.${key}=${JSON.stringify(value)}`);
      }
    }
    if (Array.isArray(assertion.values)) {
      for (const [valueIndex, value] of assertion.values.entries()) {
        if (HAN_RE.test(value)) {
          violations.push(`${source}:${sampleId}:${assertionPath}.values[${valueIndex}]=${JSON.stringify(value)}`);
        }
      }
    }
    if (Array.isArray(assertion.children)) {
      visitAssertions(source, sampleId, assertion.children, `${assertionPath}.children`, violations);
    }
  }
}

describe('eval sample assertion language', () => {
  it('keeps shipped assertion payloads English-only', () => {
    const files = collectEvalSampleFiles(join(PROJECT_ROOT, 'examples'));
    const violations = files.flatMap((file) => {
      const { samples } = loadSamples(file);
      return collectAssertionViolations(file, samples);
    });
    assert.deepEqual(violations, []);
  });

  it('keeps init scaffold assertion payloads English-only', async () => {
    // 真子进程验证 `omk init` 生成的 samples；dist 缺失时 cli-process helper 给出 build hint。
    const dir = mkdtempSync(join(tmpdir(), 'omk-init-assertions-'));
    try {
      await runCli(['init', dir, '--lang', 'zh']);
      const { samples } = loadSamples(join(dir, 'eval-samples.json'));
      assert.deepEqual(collectAssertionViolations('omk init', samples), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
