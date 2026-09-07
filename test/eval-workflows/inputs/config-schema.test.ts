import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEvalConfig } from '../../../src/eval-workflows/inputs/eval-config.js';
import type { EvalConfig } from '../../../src/eval-workflows/inputs/contracts/config.js';
import { EVAL_CONFIG_DEFAULTS, EVAL_CONFIG_SCHEMA_SOURCE_PATHS } from '../../../src/eval-workflows/inputs/contracts/config-schema.js';
import { parseCliEvaluationRequest } from '../../../src/eval-workflows/input-compilation/index.js';

function withConfig(extra: Record<string, unknown>, check: (value: EvalConfig) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'omk-config-schema-'));
  try {
    const file = join(root, 'eval.yaml');
    writeFileSync(file, JSON.stringify({
      samples: './samples.json',
      variants: [{ name: 'control', role: 'control', artifact: 'baseline' }],
      ...extra,
    }));
    check(loadEvalConfig(file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function parseFlags(flags: Record<string, unknown>) {
  return parseCliEvaluationRequest({
    explicitCliFlags: { control: 'baseline', treatment: 'candidate', ...flags },
    defaults: {
      samplesLocator: 'eval-samples.json',
      skillDirectoryLocator: 'skills',
      targetRuntime: { executorId: 'codex', model: 'gpt-example', effort: 'low' },
      judgeMembers: [{ executorId: 'codex', model: 'gpt-example' }],
      presentation: {
        projectOutputDirectoryLocator: '.omk/eval',
        globalOutputDirectoryLocator: '/global/eval',
        language: 'zh',
        languageDefaultSource: 'environment-selection',
      },
    },
  });
}

describe('EvalConfig single schema boundaries', () => {
  it('preserves stripped unknown fields and materialized optional keys', () => {
    withConfig({ unused: true, budget: { totalUSD: 1, unused: true } }, (config) => {
      assert.equal(Object.hasOwn(config, 'unused'), false);
      assert.equal(Object.hasOwn(config.budget!, 'unused'), false);
      assert.equal(Object.hasOwn(config.budget!, 'perSampleMs'), true);
      assert.equal(Object.hasOwn(config.variants[0], 'cwd'), true);
      for (const key of EVAL_CONFIG_SCHEMA_SOURCE_PATHS.filter((key) => !key.includes('.'))) {
        assert.equal(Object.hasOwn(config, key), true);
      }
    });
  });

  it('continues rejecting unknown decision keys', () => {
    assert.throws(() => withConfig({ decision: { unused: true } }, () => {}), /decision.unused is not supported/);
  });

  it('keeps ordinary integer and safe integer acceptance distinct', () => {
    const value = Number.MAX_SAFE_INTEGER + 1;
    withConfig({ repeat: value }, (config) => assert.equal(config.repeat, value));
    assert.throws(() => withConfig({ decision: { minimumComparisonUnits: value } }, () => {}), /positive safe integer/);
  });

  it('keeps explicit null target power distinct from an absent target power', () => {
    const power = { minimumDetectableDifference: 0.5, expectedDifferenceStandardDeviation: 1, assumptionSource: ' pilot ' };
    withConfig({ decision: { power } }, (config) => {
      assert.equal(Object.hasOwn(config.decision!.power!, 'targetPower'), false);
      assert.equal(config.decision!.power!.assumptionSource, 'pilot');
    });
    withConfig({ decision: { power: { ...power, targetPower: null } } }, (config) => {
      assert.equal(config.decision!.power!.targetPower, EVAL_CONFIG_DEFAULTS.targetPower);
    });
  });

  it('does not trim variant identity while trimming deployment revision', () => {
    withConfig({
      variants: [{ name: ' spaced ', role: 'control', artifact: 'baseline' }],
      judgeModels: [{ executor: 'codex', model: 'model', deploymentRevision: ' revision ' }],
    }, (config) => {
      assert.equal(config.variants[0].name, ' spaced ');
      assert.equal(config.judgeModels![0].deploymentRevision, 'revision');
    });
  });

  it.each([
    ['concurrency', 'concurrency', 0],
    ['repeat', 'repeat', 1.5],
    ['judge-repeat', 'judgeRepeat', 0],
    ['bootstrap-samples', 'bootstrapSamples', 99],
    ['holdout-ratio', 'holdoutRatio', 1],
  ])('rejects the same numeric boundary for CLI %s and config %s', (flag, key, value) => {
    assert.throws(() => parseFlags({ [flag]: String(value) }));
    assert.throws(() => withConfig({ [key]: value }, () => {}));
  });

  it('decodes CLI seconds before applying the millisecond constraint', () => {
    assert.equal(parseFlags({ timeout: '0.001' }).values.measurement.timeoutMs, 1);
    assert.throws(() => parseFlags({ timeout: '0.0001' }));
    withConfig({ timeoutMs: 1 }, (config) => assert.equal(config.timeoutMs, 1));
  });

  it('uses shared defaults after CLI decoding', () => {
    const request = parseFlags({ 'bootstrap-samples': '100' });
    assert.equal(request.values.measurement.bootstrap.resamples, 100);
    assert.equal(request.values.measurement.executionConcurrency, EVAL_CONFIG_DEFAULTS.concurrency);
    assert.equal(request.values.targetRuntime.effort, EVAL_CONFIG_DEFAULTS.effort);
  });

  it('preserves the distinct CLI and YAML decision input ranges', () => {
    const request = parseFlags({ threshold: '6', 'trivial-diff': '5' });
    assert.equal(request.values.measurement.decision.threshold, 6);
    assert.equal(request.values.measurement.decision.trivialDifference, 5);
    assert.throws(() => withConfig({ decision: { threshold: 6 } }, () => {}), /threshold/);
    assert.throws(() => withConfig({ decision: { trivialDifference: 5 } }, () => {}), /trivialDifference/);
  });
});
