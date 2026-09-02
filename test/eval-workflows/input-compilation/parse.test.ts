import { describe, expect, it } from 'vitest';
import type { EvalConfig } from '../../../src/eval-workflows/inputs/contracts/config.js';
import {
  compileCliEvaluationInput,
  parseCliEvaluationRequest,
  type CliEvaluationParseDefaults,
  type CliEvaluationRequest,
  type ResolvedCliEvaluationInput,
} from '../../../src/eval-workflows/input-compilation/index.js';
import { validResolvedCliInput } from './fixtures.js';

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;

const defaults: CliEvaluationParseDefaults = {
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
};

const equivalentConfig: EvalConfig = {
  samples: 'samples.yaml',
  executor: 'codex',
  model: 'gpt-example',
  effort: 'high',
  noDiagnostic: true,
  skipDoctor: true,
  judgeModels: [
    { executor: 'anthropic-api', model: 'judge-a' },
    { executor: 'openai-api', model: 'judge-b' },
  ],
  concurrency: 2,
  timeoutMs: 90_000,
  noCache: true,
  noJudge: false,
  mcpConfig: 'mcp.json',
  variants: [
    { name: 'control', role: 'control', artifact: 'control' },
    { name: 'treatment', role: 'treatment', artifact: 'treatment' },
  ],
  budget: { totalUSD: 10, perSampleUSD: 1, perSampleMs: 30_000 },
  repeat: 3,
  holdoutRatio: 0.5,
  judgeRepeat: 2,
  bootstrap: true,
  bootstrapSamples: 1000,
  goldDir: 'gold',
  lengthDebias: false,
  strictBaseline: false,
};

function resolveWithDeterministicTestResources(
  request: CliEvaluationRequest,
): ResolvedCliEvaluationInput {
  const resolved = structuredClone(validResolvedCliInput()) as Mutable<ResolvedCliEvaluationInput>;
  for (const target of resolved.targets) {
    target.executor.model = request.values.targetRuntime.model;
    target.executor.effort = request.values.targetRuntime.effort;
  }
  resolved.judges.enabled = request.values.judges.enabled;
  resolved.judges.replicateCount = request.values.judges.replicateCount;
  resolved.judges.members = request.values.judges.members.map((member, index) => ({
    ensembleMemberId: `judge-${index}`,
    executorId: member.executorId,
    model: member.model,
    effort: request.values.targetRuntime.effort,
  }));
  resolved.policy.executionConcurrency = request.values.measurement.executionConcurrency;
  resolved.policy.evaluationConcurrency = request.values.measurement.executionConcurrency;
  resolved.policy.executionTimeoutMs = request.values.measurement.timeoutMs;
  resolved.policy.retryCount = request.values.measurement.retryCount;
  resolved.policy.cache = request.values.measurement.cache;
  resolved.policy.budget = request.values.measurement.budget;
  resolved.orchestration.dryRun = request.values.orchestration.dryRun;
  resolved.orchestration.batch = request.values.orchestration.batch;
  resolved.orchestration.preflight = request.values.orchestration.preflight;
  resolved.orchestration.diagnostic = request.values.orchestration.diagnostic;
  resolved.orchestration.managedEvidence = request.values.orchestration.managedEvidence;
  resolved.orchestration.independentSeries = request.values.orchestration.repeatCount > 1
    ? {
        repeatCount: request.values.orchestration.repeatCount,
        seriesInstanceId: 'cli-yaml-equivalence-series',
      }
    : undefined;
  resolved.presentation = structuredClone(request.values.presentation);
  return resolved;
}

describe('parseCliEvaluationRequest', () => {
  it('records a host-discovered project MCP config as a derived locator', () => {
    const parsed = parseCliEvaluationRequest({
      explicitCliFlags: { control: 'control', treatment: 'treatment' },
      defaults: { ...defaults, mcpConfigLocator: '/project/.mcp.json' },
    });

    expect(parsed.values.locators.mcpConfig).toBe('/project/.mcp.json');
    expect(parsed.fieldSources).toContainEqual({
      normalizedField: 'values.locators.mcpConfig',
      sourceKind: 'host-default',
      sourceKey: 'values.locators.mcpConfig',
      defaultSource: 'derived',
    });
  });

  it('normalizes equivalent explicit CLI and eval.yaml sources to the same request values', () => {
    const cliRequest = parseCliEvaluationRequest({
      explicitCliFlags: {
        control: 'control',
        treatment: 'treatment',
        samples: 'samples.yaml',
        executor: 'codex',
        model: 'gpt-example',
        effort: 'high',
        'no-diagnostic': true,
        'skip-doctor': true,
        'judge-models': 'anthropic-api:judge-a,openai-api:judge-b',
        concurrency: '2',
        timeout: '90',
        'no-cache': true,
        'mcp-config': 'mcp.json',
        'budget-usd': '10',
        'budget-per-sample-usd': '1',
        'budget-per-sample-ms': '30000',
        repeat: '3',
        'holdout-ratio': '0.5',
        'judge-repeat': '2',
        bootstrap: true,
        'bootstrap-samples': '1000',
        'gold-dir': 'gold',
        'no-debias-length': true,
        'no-strict-baseline': true,
      },
      defaults,
    });
    const yamlRequest = parseCliEvaluationRequest({
      explicitCliFlags: {},
      evalConfig: equivalentConfig,
      defaults,
    });

    expect(cliRequest.values).toEqual(yamlRequest.values);
    expect(cliRequest.fieldSources).not.toEqual(yamlRequest.fieldSources);
    expect(cliRequest.fieldSources).toContainEqual(expect.objectContaining({
      normalizedField: 'values.targetRuntime.model',
      sourceKind: 'cli-flag',
      sourceKey: 'model',
    }));
    expect(yamlRequest.fieldSources).toContainEqual(expect.objectContaining({
      normalizedField: 'values.targetRuntime.model',
      sourceKind: 'eval-config',
      sourceKey: 'model',
    }));
    const cliContract = compileCliEvaluationInput(resolveWithDeterministicTestResources(cliRequest));
    const yamlContract = compileCliEvaluationInput(resolveWithDeterministicTestResources(yamlRequest));
    expect(cliContract.canonicalDigests).toEqual(yamlContract.canonicalDigests);
  });

  it('disables judges before parsing an unused judge source', () => {
    const request = parseCliEvaluationRequest({
      explicitCliFlags: {
        control: 'control', treatment: 'treatment',
        'no-judge': true,
        'judge-models': 'not-a-valid-judge',
      },
      defaults,
    });

    expect(request.values.judges).toMatchObject({ enabled: false, members: [] });
  });

  it('rejects conflicting baseline isolation flags with a stable code', () => {
    expect(() => parseCliEvaluationRequest({
      explicitCliFlags: {
        control: 'control', treatment: 'treatment',
        'strict-baseline': true,
        'no-strict-baseline': true,
      },
      defaults,
    })).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_BASELINE_ISOLATION_CONFLICT',
    }));
  });

  it('records environment-selected language separately from the zh fallback value', () => {
    const request = parseCliEvaluationRequest({
      explicitCliFlags: { control: 'control', treatment: 'treatment' },
      defaults: {
        ...defaults,
        presentation: {
          ...defaults.presentation,
          language: 'en',
          languageDefaultSource: 'environment-selection',
        },
      },
    });

    expect(request.values.presentation.language).toBe('en');
    expect(request.fieldSources).toContainEqual({
      normalizedField: 'values.presentation.language',
      sourceKind: 'host-default',
      sourceKey: 'language',
      defaultSource: 'environment-selection',
    });
  });

  it.each([
    ['negative concurrency', { concurrency: -3 }, 'concurrency'],
    ['fractional concurrency', { concurrency: 1.5 }, 'concurrency'],
    ['fractional bootstrap samples', { bootstrapSamples: 100.5 }, 'bootstrapSamples'],
    ['non-finite budget', { budget: { totalUSD: Number.NaN } }, 'budget.totalUSD'],
    ['zero duration budget', { budget: { perSampleMs: 0 } }, 'budget.perSampleMs'],
    ['non-boolean legacy cache toggle', { noCache: 'false' as unknown as boolean }, 'noCache'],
  ])('rejects invalid syntax-normalized eval config values: %s', (_name, override, fieldPath) => {
    expect(() => parseCliEvaluationRequest({
      explicitCliFlags: {},
      evalConfig: { ...equivalentConfig, ...override },
      defaults,
    })).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_INVALID',
      fieldPath,
    }));
  });

  it('records provenance only for normalized fields that actually exist', () => {
    const request = parseCliEvaluationRequest({
      explicitCliFlags: { control: 'control', treatment: 'treatment' },
      defaults,
    });

    expect(request.values.measurement.decision).toEqual({});
    expect(request.fieldSources.some((source) => (
      source.normalizedField === 'values.measurement.decision.threshold'
      || source.normalizedField === 'values.measurement.decision.trivialDifference'
    ))).toBe(false);
    expect(request.fieldSources).toContainEqual(expect.objectContaining({
      normalizedField: 'values.measurement.timeoutMs',
      sourceKind: 'documented-default',
    }));
    expect(request.values.measurement.cache).toEqual({
      executionMode: 'disabled',
      evaluationMode: 'disabled',
    });
    expect(request.fieldSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        normalizedField: 'values.measurement.cache.executionMode',
        sourceKind: 'documented-default',
      }),
      expect.objectContaining({
        normalizedField: 'values.measurement.cache.evaluationMode',
        sourceKind: 'documented-default',
      }),
    ]));
  });

  it('accepts legacy disable-only input without inferring a cache-enabled mode', () => {
    const request = parseCliEvaluationRequest({
      explicitCliFlags: {
        control: 'control', treatment: 'treatment', 'no-cache': true,
      },
      defaults,
    });

    expect(request.values.measurement.cache).toEqual({
      executionMode: 'disabled',
      evaluationMode: 'disabled',
    });
    expect(request.fieldSources).toContainEqual({
      normalizedField: 'values.measurement.cache.executionMode',
      sourceKind: 'cli-flag',
      sourceKey: 'no-cache',
    });
  });

  it.each([
    ['CLI', { explicitCliFlags: {
      control: 'control', treatment: 'treatment', 'no-cache': false,
    } }],
    ['eval.yaml', { explicitCliFlags: {}, evalConfig: {
      ...equivalentConfig, noCache: false,
    } }],
  ] as const)('rejects legacy cache enablement from %s', (_label, input) => {
    expect(() => parseCliEvaluationRequest({ ...input, defaults }))
      .toThrowError(expect.objectContaining({
        code: 'CLI_INPUT_LEGACY_CACHE_ENABLE_UNSUPPORTED',
      }));
  });
});
