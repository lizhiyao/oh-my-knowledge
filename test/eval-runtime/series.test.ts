import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  createRunStabilityRuntime,
  createRunStabilitySchemaValidators,
  runEvaluationSeries,
  type EvaluationSeriesMemberSource,
} from '../../src/eval-core/index.js';
import {
  EvaluationConfigurationError,
  evaluateSeries,
  prepareEvaluationSeries,
  type Clock,
  type EvaluateInput,
  type Executor,
} from '../../src/eval-runtime/index.js';
import {
  createCanonicalEvaluationSeriesMemberSource,
} from '../../src/eval-runtime/evaluate.js';

type Input = { question: string };
type Config = { answers: string[] };

const fixedClock: Clock = {
  monotonicNow: () => 0,
  timestamp: () => '2026-09-05T00:00:00.000Z',
  sleep: () => Promise.resolve(),
};

function repeatabilityInput(executor: Executor<Input, Config, string>): EvaluateInput {
  return {
    dataset: {
      datasetId: 'repeatability-dataset',
      samples: [{ sampleId: 'one', input: { question: 'one' }, expected: 'A' }],
    },
    variants: [{
      variantId: 'candidate',
      artifact: {
        name: 'candidate',
        kind: 'prompt',
        source: 'inline',
        content: 'Answer the question.',
      },
      execution: { executor, config: { answers: ['A', 'B', 'A'] } },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' }],
    comparisons: [],
    analyses: [{
      analysisId: 'candidate-correct-rate',
      analysisKind: 'summary',
      statistic: 'rate',
      variantId: 'candidate',
      metricId: 'correct',
    }],
    experiment: {
      seed: 'fixed-repeatability-seed',
      sampling: { samplingKind: 'solo' },
    },
    policy: {
      execution: { maxConcurrency: 1 },
      evaluation: { maxConcurrency: 1 },
      cache: { execution: 'disabled', evaluation: 'disabled' },
    },
  };
}

function executor(
  execute: Executor<Input, Config, string>['execute'],
): Executor<Input, Config, string> {
  return {
    executorId: 'test.repeatability-executor/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ question: z.string() }).strict(),
      config: z.object({ answers: z.array(z.string()) }).strict(),
      output: z.string(),
    },
    outputClassification: 'public',
    capabilities: {
      determinism: 'stochastic',
      cancellation: 'cooperative',
      concurrency: { safety: 'serialized' },
      seedControl: 'optional',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    fingerprintFacets: { revision: 'test-one' },
    execute,
  };
}

describe('canonical Evaluation Series facade', () => {
  it('preregisters every fixed-design member before any Target call', async () => {
    const execute = vi.fn(async () => ({ output: 'A' }));
    const prepared = await prepareEvaluationSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'release-repeatability',
      repeatCount: 3,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(prepared.definition.analysisMode).toBe('preregistered');
    expect(prepared.definition.experimentalUnit).toBe('run');
    expect(prepared.definition.comparabilityPolicy).toMatchObject({
      comparisonScope: 'analysis',
      minimumStatus: 'conditional',
    });
    expect(prepared.memberPlans).toHaveLength(3);
    expect(new Set(prepared.memberPlans.map((plan) => (
      plan.digests.runContractDigest
    ))).size).toBe(3);
    expect(new Set(prepared.memberPlans.map((plan) => (
      plan.digests.analysisPlanDigest
    ))).size).toBe(1);
    expect(prepared.memberPlans.map((plan) => plan.definition.seriesMembership)).toEqual(
      prepared.definition.members.map((member) => ({
        seriesDesignDigest: prepared.definition.seriesDesignDigest,
        memberId: member.memberId,
        replicateIndex: member.replicateIndex,
      })),
    );
    expect(prepared.estimatedWork).toMatchObject({
      repeatCount: 3,
      executionCoordinates: 3,
      evaluationCoordinates: 3,
      plannedInvocations: 6,
    });
  });

  it('reports descriptive run-level repeatability without inventing a verdict', async () => {
    let call = 0;
    const execute = vi.fn(async ({ config }: { config: Config }) => ({
      output: config.answers[call++]!,
    }));
    const result = await evaluateSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'known-vector',
      repeatCount: 3,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    }, { clock: fixedClock });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completed Series result.');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.members).toHaveLength(3);
    expect(result.members.every((member) => (
      member.memberStatus === 'produced' && member.admissionStatus === 'admitted'
    ))).toBe(true);
    expect(result.analysis).toMatchObject({
      coverage: { planned: 3, completed: 3, comparable: 3, missing: 0 },
    });
    expect(result.stability).toMatchObject({
      analysisStatus: 'completed',
      resultType: 'table',
      value: {
        experimentalUnit: 'run',
        runCount: 3,
        mean: 2 / 3,
        minimum: 0,
        maximum: 1,
        range: 1,
      },
    });
    if (result.stability?.analysisStatus !== 'completed'
        || typeof result.stability.value !== 'object'
        || result.stability.value === null
        || Array.isArray(result.stability.value)) {
      throw new Error('Expected completed stability table.');
    }
    expect(result.stability.value.sampleVariance).toBeCloseTo(1 / 3);
    expect(result.stability.value.sampleStandardDeviation).toBeCloseTo(Math.sqrt(1 / 3));
    expect(result.decision).toBeUndefined();
    expect(result.report).not.toHaveProperty('decision');
    expect(result.analysisResults['run-stability']).toBe(result.stability);
  });

  it('is canonically equivalent to assembling the same authenticated Series in Core', async () => {
    const execute = vi.fn(async () => ({ output: 'A' }));
    const result = await evaluateSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'core-equivalence',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    }, { clock: fixedClock });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completed Series result.');

    const sources: EvaluationSeriesMemberSource[] = [];
    for (const member of result.members) {
      if (member.memberStatus !== 'produced' || member.admissionStatus !== 'admitted') {
        throw new Error('Expected every Series member to be admitted.');
      }
      const source = createCanonicalEvaluationSeriesMemberSource(member.result, {
        seriesDesignDigest: result.definition.seriesDesignDigest,
        memberId: member.memberId,
        replicateIndex: member.replicateIndex,
      });
      if (source === undefined) throw new Error('Expected authenticated member source.');
      sources.push(source);
    }
    const runtime = createRunStabilityRuntime();
    const manual = await runEvaluationSeries(result.plan, sources, {
      analysisNodesByNodeId: new Map([['run-stability', runtime]]),
      decisionPoliciesByDecisionPolicyId: new Map(),
      schemaValidators: createRunStabilitySchemaValidators(),
      clock: fixedClock,
    }, {
      runId: 'manual-core-equivalence',
      bundleId: result.analysis.bundleId,
      reportId: result.report.reportId,
    });

    expect(manual).toEqual({
      status: 'completed',
      analysis: result.analysis,
      report: result.report,
    });
  });

  it('uses interval estimates only when explicitly declared', async () => {
    const execute = vi.fn(async () => ({ output: 'A' }));
    const base = repeatabilityInput(executor(execute));
    const input: EvaluateInput = {
      ...base,
      dataset: {
        datasetId: 'repeatability-interval-dataset',
        samples: [
          { sampleId: 'one', input: { question: 'one' }, expected: 'A' },
          { sampleId: 'two', input: { question: 'two' }, expected: 'A' },
        ],
      },
      analyses: [{
        analysisId: 'candidate-quality',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: 'candidate',
        metricId: 'correct',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }],
    };
    const result = await evaluateSeries({
      evaluation: input,
      seriesInstanceId: 'interval-repeatability',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-quality',
        projection: 'interval-estimate',
        minimumMemberEvidenceStatus: 'partial',
      },
    }, { clock: fixedClock });

    expect(result.stability).toMatchObject({
      analysisStatus: 'completed',
      value: { members: [{ value: 1 }, { value: 1 }], sampleVariance: 0 },
    });
  });

  it('fails before effects for cache, projection, and second execution', async () => {
    const execute = vi.fn(async () => ({ output: 'A' }));
    const base = repeatabilityInput(executor(execute));
    const cached: EvaluateInput = {
      ...base,
      policy: { ...base.policy, cache: { execution: 'reuse' } },
    };
    await expect(prepareEvaluationSeries({
      evaluation: cached,
      seriesInstanceId: 'cached-repeatability',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_SERIES_INVALID' });
    expect(execute).not.toHaveBeenCalled();

    await expect(prepareEvaluationSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'wrong-projection',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'interval-estimate',
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_SERIES_INVALID' });
    expect(execute).not.toHaveBeenCalled();

    const prepared = await prepareEvaluationSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'single-use',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    });
    const first = prepared.run({ clock: fixedClock });
    expect(() => prepared.run({ clock: fixedClock })).toThrow(EvaluationConfigurationError);
    await first;
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('captures mutable input once and seals every design-affecting Series option', async () => {
    const pendingInput: {
      evaluation: EvaluateInput;
      seriesInstanceId: string;
      repeatCount: number;
      stability: { sourceAnalysisId: string; projection: 'scalar' };
    } = {
      evaluation: repeatabilityInput(executor(vi.fn(async () => ({ output: 'A' })))),
      seriesInstanceId: 'pending-capture',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    };
    const pending = prepareEvaluationSeries(pendingInput);
    pendingInput.seriesInstanceId = 'mutated-after-call';
    pendingInput.repeatCount = 1_000_000;
    pendingInput.stability.sourceAnalysisId = 'mutated-analysis';
    const pendingPrepared = await pending;
    expect(pendingPrepared.memberPlans).toHaveLength(2);
    expect(pendingPrepared.seriesId).toMatch(/^pending-capture-/);
    expect(pendingPrepared.definition.analysisGraph.nodes[0]?.parameters).toMatchObject({
      sourceAnalysisResultId: 'candidate-correct-rate',
    });

    const answers = ['A'];
    const execute = vi.fn(async ({ config }: { config: Config }) => ({
      output: config.answers[0]!,
    }));
    const input = repeatabilityInput(executor(execute));
    const config = input.variants[0]?.execution.config as Config;
    config.answers = answers;
    const prepared = await prepareEvaluationSeries({
      evaluation: input,
      seriesInstanceId: 'captured-series',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    });
    answers[0] = 'B';
    const result = await prepared.run({ clock: fixedClock });

    expect(result.stability).toMatchObject({
      analysisStatus: 'completed',
      value: { mean: 1 },
    });
    const same = await prepareEvaluationSeries({
      evaluation: repeatabilityInput(executor(vi.fn(async () => ({ output: 'A' })))),
      seriesInstanceId: 'design-identity',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    });
    const changed = await prepareEvaluationSeries({
      evaluation: repeatabilityInput(executor(vi.fn(async () => ({ output: 'A' })))),
      seriesInstanceId: 'design-identity',
      repeatCount: 3,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    });
    expect(changed.definition.seriesDesignDigest).not.toBe(
      same.definition.seriesDesignDigest,
    );
  });

  it('does not replace failed members or stop later preregistered Runs', async () => {
    let call = 0;
    const execute = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('private provider failure');
      return { output: 'A' };
    });
    const result = await evaluateSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'failed-member-series',
      repeatCount: 3,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    }, { clock: fixedClock });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.members).toHaveLength(3);
    expect(result.analysis?.coverage).toMatchObject({
      planned: 3,
      completed: 2,
      partial: 1,
      missing: 0,
    });
    expect(result.stability).toMatchObject({
      analysisStatus: 'inconclusive',
      reasonCodes: ['series-stability-complete-coverage-required'],
    });
  });

  it('keeps trials nested within each Run and resets Run budgets per member', async () => {
    const trialSeeds: string[] = [];
    const execute = vi.fn(async ({ trialSeed }: { trialSeed?: string }) => {
      if (trialSeed !== undefined) trialSeeds.push(trialSeed);
      return { output: 'A' };
    });
    const base = repeatabilityInput(executor(execute));
    const result = await evaluateSeries({
      evaluation: {
        ...base,
        experiment: { ...base.experiment, trials: 2 },
        policy: {
          ...base.policy,
          budget: { run: { maxInvocations: 4 } },
        },
      },
      seriesInstanceId: 'nested-trials-series',
      repeatCount: 3,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    }, { clock: fixedClock });

    expect(execute).toHaveBeenCalledTimes(6);
    expect(trialSeeds.slice(0, 2)).toEqual(trialSeeds.slice(2, 4));
    expect(trialSeeds.slice(0, 2)).toEqual(trialSeeds.slice(4, 6));
    expect(result.analysis?.coverage).toMatchObject({ planned: 3, completed: 3 });
    expect(result.stability).toMatchObject({
      analysisStatus: 'completed',
      value: { experimentalUnit: 'run', runCount: 3, mean: 1 },
    });
  });

  it('can require verified-compatible members instead of conditional identities', async () => {
    const execute = vi.fn(async () => ({ output: 'A' }));
    const result = await evaluateSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'compatible-only-series',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
        minimumComparabilityStatus: 'compatible',
      },
    }, { clock: fixedClock });

    expect(result.analysis).toMatchObject({
      coverage: { planned: 2, comparable: 1 },
      records: [{
        analysisStatus: 'inconclusive',
        reasonCodes: ['series-comparable-members-insufficient'],
      }],
    });
  });

  it('rejects invalid repeat counts before invoking a Target', async () => {
    const execute = vi.fn(async () => ({ output: 'A' }));
    await expect(prepareEvaluationSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'invalid-repeat-count',
      repeatCount: 1,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_SERIES_INVALID' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed signal and clock options before invoking a Target', async () => {
    const execute = vi.fn(async () => ({ output: 'A' }));
    const first = await prepareEvaluationSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'invalid-signal',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    });
    expect(() => first.run({
      signal: { aborted: false, addEventListener() {} },
    } as never)).toThrow(EvaluationConfigurationError);
    await first.run({ clock: fixedClock });

    const second = await prepareEvaluationSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'invalid-clock',
      repeatCount: 2,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    });
    expect(() => second.run({ clock: null } as never)).toThrow(EvaluationConfigurationError);
    await second.run({ clock: fixedClock });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('stops scheduling after cancellation and keeps every planned slot visible', async () => {
    const execute = vi.fn(async () => ({ output: 'A' }));
    const controller = new AbortController();
    controller.abort('cancel before run');
    const result = await evaluateSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'cancelled-series',
      repeatCount: 3,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    }, { signal: controller.signal, clock: fixedClock });

    expect(execute).not.toHaveBeenCalled();
    expect(result.memberExecutionStatus).toBe('cancelled');
    expect(result.members).toHaveLength(3);
    expect(result.members.every((member) => (
      member.memberStatus === 'not-produced'
        && member.reasonCode === 'series-member-cancelled-before-start'
    ))).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.analysis).toBeUndefined();
    expect(result.stability).toBeUndefined();
  });

  it('does not start a later member after cancellation during an active Run', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort('stop after first Target call');
      return { output: 'A' };
    });
    const result = await evaluateSeries({
      evaluation: repeatabilityInput(executor(execute)),
      seriesInstanceId: 'mid-run-cancelled-series',
      repeatCount: 3,
      stability: {
        sourceAnalysisId: 'candidate-correct-rate',
        projection: 'scalar',
      },
    }, { signal: controller.signal, clock: fixedClock });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.memberExecutionStatus).toBe('cancelled');
    expect(result.members.slice(1).every((member) => (
      member.memberStatus === 'not-produced'
        && member.reasonCode === 'series-member-cancelled-before-start'
    ))).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.analysis).toBeUndefined();
    expect(result.stability).toBeUndefined();
  });
});
