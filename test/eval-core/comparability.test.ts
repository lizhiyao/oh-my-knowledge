import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  crossReportComparabilityWarnings,
  formatComparabilityWarnings,
  reportComparabilityWarnings,
} from '../../src/eval-core/comparability.js';
import type { ExecutorRuntimeFingerprint, Report } from '../../src/types/index.js';

function runtime(executor: string, model: string, fingerprint: string): ExecutorRuntimeFingerprint {
  return {
    executor,
    model,
    kind: 'agent-sdk',
    fingerprint,
    binary: { name: executor, source: 'bundled', version: '1.0.0' },
    sdk: { name: `${executor}-sdk`, version: '1.0.0' },
    capabilities: {
      systemPrompt: 'native',
      costUSD: 'reported',
      trace: 'native',
      skillIsolation: 'full',
    },
  };
}

function report(overrides: Partial<Report['meta']> = {}): Report {
  return {
    kind: 'evaluation',
    id: 'r',
    meta: {
      variants: ['control', 'treatment'],
      model: 'm',
      judgeModel: 'j',
      executor: 'claude-sdk',
      sampleCount: 2,
      taskCount: 4,
      totalCostUSD: 0,
      timestamp: '2026-05-01T00:00:00.000Z',
      cliVersion: '0.23.0',
      nodeVersion: 'v20.0.0',
      artifactHashes: { control: 'a', treatment: 'b' },
      sampleHashes: { s1: 'aaa111aaa111', s2: 'bbb222bbb222' },
      judgePromptHash: 'judge1111111',
      executorRuntime: runtime('claude-sdk', 'm', 'exec11111111'),
      judgeRuntime: runtime('claude-sdk', 'j', 'judge111111'),
      skillIsolation: { control: [], treatment: null },
      ...overrides,
    },
    summary: {},
    results: [],
  };
}

describe('comparability warnings', () => {
  it('single-report audit warns when runtime metadata is missing', () => {
    const warnings = reportComparabilityWarnings(report({ executorRuntime: undefined }));
    assert.ok(warnings.some((w) => w.code === 'executor_runtime_missing'));
  });

  it('single-report audit warns when per-variant runtime metadata is incomplete', () => {
    const warnings = reportComparabilityWarnings(report({
      executorRuntimes: { control: runtime('claude-sdk', 'm', 'exec11111111') },
    }));
    assert.ok(warnings.some((w) => w.code === 'executor_runtime_missing'));
  });

  it('single-report audit warns when runtime metadata is not verifiable', () => {
    const warnings = reportComparabilityWarnings(report({
      executorRuntime: {
        ...runtime('codex', 'm', 'exec11111111'),
        kind: 'agent-cli',
        binary: { name: 'codex', source: 'path', error: 'not found' },
        sdk: undefined,
      },
    }));
    assert.ok(warnings.some((w) => w.code === 'executor_runtime_unverifiable'));
  });

  it('warns when a judged report lacks judgePromptHash even if both sides are missing it', () => {
    const warnings = crossReportComparabilityWarnings(
      report({ judgePromptHash: undefined }),
      report({ judgePromptHash: undefined }),
    );
    assert.ok(warnings.some((w) => w.code === 'judge_prompt_hash_missing'));
  });

  it('cross-report audit detects runtime, judge prompt, sample, and isolation mismatch', () => {
    const before = report();
    const after = report({
      executorRuntime: runtime('codex-sdk', 'm', 'exec22222222'),
      judgePromptHash: 'judge2222222',
      sampleHashes: { s1: 'changed11111', s3: 'ccc333ccc333' },
      skillIsolation: { control: null, treatment: null },
    });

    const codes = crossReportComparabilityWarnings(before, after).map((w) => w.code);
    assert.ok(codes.includes('executor_runtime_mismatch'));
    assert.ok(codes.includes('judge_prompt_hash_mismatch'));
    assert.ok(codes.includes('sample_hashes_mismatch'));
    assert.ok(codes.includes('skill_isolation_mismatch'));
  });

  it('cross-report audit checks per-variant executor runtime fingerprints', () => {
    const before = report({
      executorRuntimes: {
        control: runtime('claude-sdk', 'm', 'exec11111111'),
        treatment: runtime('claude-sdk', 'm', 'exec22222222'),
      },
    });
    const after = report({
      executorRuntimes: {
        control: runtime('claude-sdk', 'm', 'exec11111111'),
        treatment: runtime('claude-sdk', 'm', 'exec33333333'),
      },
    });

    const codes = crossReportComparabilityWarnings(before, after).map((w) => w.code);
    assert.ok(codes.includes('executor_runtime_mismatch'));
  });

  it('cross-report audit warns when per-variant executor runtime is missing on one side', () => {
    const codes = crossReportComparabilityWarnings(
      report({ executorRuntimes: { control: runtime('claude-sdk', 'm', 'exec11111111') } }),
      report({ executorRuntimes: { control: runtime('claude-sdk', 'm', 'exec11111111'), treatment: runtime('claude-sdk', 'm', 'exec22222222') } }),
    ).map((w) => w.code);
    assert.ok(codes.includes('executor_runtime_missing'));
  });

  it('cross-report audit checks ensemble judge models, repeat, and per-judge runtime', () => {
    const before = report({
      judgeModels: ['claude:opus', 'openai:gpt-4o'],
      judgeRepeat: 1,
      judgeRuntimes: {
        'claude:opus': runtime('claude', 'opus', 'judge111111'),
        'openai:gpt-4o': runtime('openai-api', 'gpt-4o', 'judge222222'),
      },
    });
    const after = report({
      judgeModels: ['claude:opus', 'openai:gpt-4o'],
      judgeRepeat: 3,
      judgeRuntimes: {
        'claude:opus': runtime('claude', 'opus', 'judge333333'),
        'openai:gpt-4o': runtime('openai-api', 'gpt-4o', 'judge222222'),
      },
    });

    const codes = crossReportComparabilityWarnings(before, after).map((w) => w.code);
    assert.ok(codes.includes('judge_repeat_mismatch'));
    assert.ok(codes.includes('judge_runtime_mismatch'));
  });

  it('cross-report audit checks ensemble judge model set', () => {
    const codes = crossReportComparabilityWarnings(
      report({ judgeModels: ['claude:opus', 'openai:gpt-4o'], judgeRuntimes: {} }),
      report({ judgeModels: ['claude:opus', 'codex:gpt-5'], judgeRuntimes: {} }),
    ).map((w) => w.code);
    assert.ok(codes.includes('judge_models_mismatch'));
    assert.ok(codes.includes('judge_runtime_missing'));
  });

  it('formats warnings in Chinese', () => {
    const text = formatComparabilityWarnings(crossReportComparabilityWarnings(report(), report({ model: 'm2' })), 'zh');
    assert.match(text, /可比性提示/);
    assert.match(text, /任务执行模型不同/);
  });
});
