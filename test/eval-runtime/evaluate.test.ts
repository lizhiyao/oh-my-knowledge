import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  EvaluationEventConsumptionError,
  checkExecutor,
  evaluate,
  type Clock,
  type Executor,
  type Variant,
} from '../../src/eval-runtime/index.js';
import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  EvaluationDefinitionSchema,
  digestCanonicalJson,
} from '../../src/eval-core/contracts/index.js';

type Input = { prompt: string };
type Config = { answers: Record<string, string> };

function executor(
  execute?: Executor<Input, Config, string>['execute'],
  input: Readonly<{ executorId?: string; revision?: string }> = {},
): Executor<Input, Config, string> {
  return {
    executorId: input.executorId ?? 'test.answer-executor/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ prompt: z.string() }).strict(),
      config: z.object({ answers: z.record(z.string(), z.string()) }).strict(),
      output: z.string(),
    },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    fingerprintFacets: { deploymentRevision: input.revision ?? 'test-one' },
    execute: execute ?? (async ({ input: invocationInput, config, signal }) => {
      signal.throwIfAborted();
      return { output: config.answers[invocationInput.prompt] };
    }),
  };
}

const controlSpec = {
  variantId: 'prompt-v1',
  artifact: {
    name: 'baseline',
    kind: 'baseline',
    source: 'baseline',
    content: null,
  },
  config: { answers: { one: 'A', two: 'wrong' } },
} as const;

const treatmentSpec = {
  variantId: 'prompt-v2',
  artifact: {
    name: 'candidate',
    kind: 'prompt',
    source: 'inline',
    content: 'Answer exactly.',
  },
  runtimeContext: { values: { model: 'test-model' } },
  config: { answers: { one: 'A', two: 'B' } },
} as const;

interface VariantSpec {
  readonly variantId: string;
  readonly artifact: Variant<Input, Config, string>['artifact'];
  readonly runtimeContext?: Variant<Input, Config, string>['execution']['runtimeContext'];
  readonly config: Config;
}

function variant(
  declaration: Executor<Input, Config, string>,
  spec: VariantSpec,
): Variant<Input, Config, string> {
  return {
    variantId: spec.variantId,
    artifact: spec.artifact,
    execution: {
      executor: declaration,
      ...('runtimeContext' in spec ? { runtimeContext: spec.runtimeContext } : {}),
      config: spec.config,
    },
  };
}

const fixedClock: Clock = {
  monotonicNow: () => 0,
  timestamp: () => '2026-09-04T00:00:00.000Z',
  sleep: () => Promise.resolve(),
};

function pairedInput(
  declaration: Executor<Input, Config, string> = executor(),
) {
  return {
    dataset: {
      datasetId: 'answers',
      samples: [
        { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
        { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
      ],
    },
    variants: [variant(declaration, controlSpec), variant(declaration, treatmentSpec)],
    evaluators: [{ evaluatorKind: 'exact-match' as const }],
    comparisons: [{
      comparisonId: 'baseline-vs-candidate',
      comparisonKind: 'paired' as const,
      controlVariantId: controlSpec.variantId,
      treatmentVariantIds: [treatmentSpec.variantId],
      metricIds: ['correct'],
    }],
    analysis: { bootstrap: { resamples: 100 } },
    experiment: {
      seed: 'fixed-seed',
      sampling: { samplingKind: 'paired' as const },
    },
    decision: {
      decisionKind: 'comparison' as const,
      comparisonId: 'baseline-vs-candidate',
      treatmentVariantId: treatmentSpec.variantId,
      metricId: 'correct',
    },
    policy: { maxConcurrency: 2 },
    runId: 'canonical-evaluate',
  };
}

function stableFacadeId(
  identityKind: 'node' | 'result' | 'decision' | 'slot',
  selector: Readonly<Record<string, string>>,
): string {
  return `${identityKind}:${digestCanonicalJson({
    derivation: 'omk.eval-runtime.definition-binding/v1',
    selector,
  }).slice('sha256:'.length)}`;
}

describe('canonical eval-runtime API', () => {
  it('evaluates an explicit paired comparison without assigning a global experiment role', async () => {
    const seen: Array<{ variantId: string; artifactName: string; model?: string }> = [];
    const declaration = executor(async (invocation) => {
      seen.push({
        variantId: invocation.variantId,
        artifactName: invocation.artifact.name,
        model: (invocation.runtimeContext?.values as { model?: string } | undefined)?.model,
      });
      return { output: invocation.config.answers[invocation.input.prompt] };
    });
    const result = await evaluate(pairedInput(declaration));

    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.artifacts === undefined) return;
    expect(result.definition.targets.map((target) => (
      (target.config as { schemaVersion: string }).schemaVersion
    ))).toEqual([
      'omk.eval-runtime.variant-config/v3',
      'omk.eval-runtime.variant-config/v3',
    ]);
    expect(result.definition.comparisons).toEqual([{
      comparisonId: 'baseline-vs-candidate',
      controlTargetId: 'prompt-v1',
      treatmentTargetIds: ['prompt-v2'],
      metricIds: ['correct'],
    }]);
    expect(result.definition.decisionPolicy).toMatchObject({
      implementationId: 'progress/v2',
      comparisonFamily: [{
        comparisonId: 'baseline-vs-candidate',
        treatmentTargetId: 'prompt-v2',
        metricId: 'correct',
      }],
    });
    expect(result.artifacts.analysis.records[0]).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 0.5 },
    });
    expect(result.artifacts.execution.records[0].runtime.fingerprint).toBe(
      'sha256:d29c4becb1812eb4951220d5b3cf8825ee9d66c23e3908d0832512e90468ff80',
    );
    expect(new Set(seen.map((item) => item.variantId))).toEqual(
      new Set(['prompt-v1', 'prompt-v2']),
    );
    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({
        variantId: 'prompt-v2',
        artifactName: 'candidate',
        model: 'test-model',
      }),
    ]));
  });

  it('produces a solo quality profile without a fabricated Comparison', async () => {
    const declaration = executor();
    const result = await evaluate({
      dataset: pairedInput().dataset,
      variants: [variant(declaration, treatmentSpec)],
      evaluators: [{ evaluatorKind: 'exact-match' }],
      comparisons: [],
      analysis: { bootstrap: { resamples: 100 } },
      experiment: { seed: 'solo-seed', sampling: { samplingKind: 'solo' } },
      decision: {
        decisionKind: 'quality',
        variantId: treatmentSpec.variantId,
        metricId: 'correct',
        threshold: 0.5,
      },
      policy: {},
      runId: 'solo-quality',
      clock: fixedClock,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.artifacts === undefined) return;
    expect(result.definition.comparisons).toEqual([]);
    expect(result.definition.experiment.sampling).toMatchObject({
      experimentalUnit: 'sample',
      resamplingUnit: 'sample',
      estimatorId: 'bootstrap.mean-percentile/v1',
      seedCoupling: 'independent-by-target',
    });
    expect(result.definition.analysisGraph.nodes).toHaveLength(1);
    expect(result.definition.analysisGraph.nodes[0]).toMatchObject({
      implementationId: 'bootstrap.mean-percentile/v1',
      inputs: [{ inputKind: 'metric-observations', referenceId: 'correct' }],
    });
    expect(result.artifacts.execution?.records).toHaveLength(2);
  });

  it('runs three Variants, heterogeneous Executors, and two Metrics in one Core Run', async () => {
    const firstExecutor = executor();
    const secondExecutor = executor(undefined, {
      executorId: 'test.alternate-executor/v1',
      revision: 'alternate-one',
    });
    const thirdSpec = {
      ...treatmentSpec,
      variantId: 'prompt-v3',
      artifact: { ...treatmentSpec.artifact, name: 'candidate-three' },
    } as const;
    const judgeCalls: string[] = [];
    const result = await evaluate({
      ...pairedInput(firstExecutor),
      variants: [
        variant(firstExecutor, controlSpec),
        variant(firstExecutor, treatmentSpec),
        variant(secondExecutor, thirdSpec),
      ],
      evaluators: [
        { evaluatorKind: 'exact-match' },
        {
          evaluatorKind: 'rubric-judge',
          evaluatorId: 'quality-judge',
          metricId: 'quality-score',
          model: 'judge-model',
          rubric: {
            criterionId: 'quality',
            prompt: 'Judge answer quality.',
            rubric: '5 is correct; 1 is incorrect.',
          },
          judge: {
            judgeId: 'test.judge/v1',
            version: '1.0.0',
            providerCost: { reporting: 'optional' },
            async invoke(request) {
              judgeCalls.push(request.promptId);
              return {
                invocationStatus: 'completed',
                output: '{"score":5,"reason":"correct"}',
              };
            },
          },
        },
      ],
      comparisons: [{
        comparisonId: 'baseline-vs-candidates',
        comparisonKind: 'paired',
        controlVariantId: controlSpec.variantId,
        treatmentVariantIds: [thirdSpec.variantId, treatmentSpec.variantId],
        metricIds: ['quality-score', 'correct'],
      }],
      decision: undefined,
      runId: 'multi-arm-multi-metric',
      clock: fixedClock,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.targets.map((target) => target.executorId)).toEqual([
      'test.answer-executor/v1',
      'test.answer-executor/v1',
      'test.alternate-executor/v1',
    ]);
    expect(result.definition.evaluators.map((evaluator) => evaluator.evaluatorId)).toEqual([
      'exact-match',
      'quality-judge',
    ]);
    expect(result.definition.metrics.map((metric) => metric.metricId)).toEqual([
      'correct',
      'quality-score',
    ]);
    expect(result.definition.comparisons[0].treatmentTargetIds).toEqual([
      'prompt-v2',
      'prompt-v3',
    ]);
    expect(result.definition.analysisGraph.nodes).toHaveLength(4);
    expect(result.definition.decisionPolicy).toBeUndefined();
    expect(result.artifacts.execution.records).toHaveLength(6);
    expect(result.artifacts.evaluation.records).toHaveLength(12);
    expect(result.artifacts.analysis.records).toHaveLength(4);
    expect(judgeCalls).toHaveLength(6);
  });

  it('compiles equivalent declarations to one canonical Core Definition', async () => {
    const declaration = executor();
    const common = pairedInput(declaration);
    const first = await evaluate({ ...common, clock: fixedClock });
    const second = await evaluate({
      ...common,
      variants: [...common.variants].reverse(),
      comparisons: [{
        ...common.comparisons[0],
        treatmentVariantIds: [...common.comparisons[0].treatmentVariantIds].reverse(),
        metricIds: [...common.comparisons[0].metricIds].reverse(),
      }],
      clock: fixedClock,
    });

    const selector = {
      analysisKind: 'comparison',
      comparisonId: 'baseline-vs-candidate',
      treatmentVariantId: 'prompt-v2',
      metricId: 'correct',
    };
    const resultId = stableFacadeId('result', selector);
    const expected = EvaluationDefinitionSchema.parse({
      schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
      dataset: common.dataset,
      targets: [controlSpec, treatmentSpec].map((spec) => ({
        targetId: spec.variantId,
        targetKind: spec.artifact.kind,
        protocolId: 'omk.invoke/v1',
        executorId: declaration.executorId,
        executionRequirements: {
          systemInstructions: 'not-required', workspace: 'not-required',
          mcp: 'not-required', mockInterception: 'not-required',
          toolPolicy: 'runtime-default', skillDiscovery: 'runtime-default',
        },
        executionControls: {
          defaults: {
            workspace: { workspaceMode: 'not-required' },
            tools: { toolPolicyKind: 'runtime-default' },
          },
          sampleOverrides: [],
        },
        config: {
          schemaVersion: 'omk.eval-runtime.variant-config/v3',
          artifact: spec.artifact,
          ...('runtimeContext' in spec ? { runtimeContext: spec.runtimeContext } : {}),
          executorConfig: spec.config,
        },
      })),
      evaluators: [{
        evaluatorId: 'exact-match',
        evaluatorKind: 'assertion',
        implementationId: 'omk.eval-runtime.exact-match/v1',
        measurement: {
          instrumentId: 'canonical-json-exact-match-v1',
          ensembleMemberId: 'deterministic-local',
          replicateGroupId: 'deterministic-primary',
          replicateIndex: 0,
        },
        metricIds: ['correct'],
        inputs: [
          { bindingId: 'actual', sourceKind: 'output', pointer: '' },
          { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
        ],
      }],
      metrics: [{
        metricId: 'correct', valueType: 'boolean', scope: 'sample',
        direction: 'higher-is-better', missingPolicyId: 'exclude/v1',
      }],
      experiment: {
        trials: 1,
        seed: 'fixed-seed',
        sampling: {
          experimentalUnit: 'sample', pairingKey: '/sampleId', repeatedMeasures: false,
          resamplingUnit: 'paired-block',
          estimatorId: 'bootstrap.paired-difference-percentile/v1',
          seedCoupling: 'shared-within-block',
        },
        scheduling: { schedulingKind: 'interleaved' },
        randomizationSlots: ['prompt-v1', 'prompt-v2'].map((variantId) => ({
          targetId: variantId,
          randomizationSlotId: stableFacadeId('slot', { variantId }),
        })).sort((left, right) => (
          left.randomizationSlotId < right.randomizationSlotId ? -1
            : left.randomizationSlotId > right.randomizationSlotId ? 1 : 0
        )),
      },
      analysisGraph: {
        analysisMode: 'preregistered',
        nodes: [{
          analysisNodeKind: 'estimator',
          nodeId: stableFacadeId('node', selector),
          implementationId: 'bootstrap.paired-difference-percentile/v1',
          inputs: [
            { inputKind: 'metric-observations', referenceId: 'correct' },
            {
              inputKind: 'comparison', referenceId: 'baseline-vs-candidate',
              treatmentTargetId: 'prompt-v2', metricId: 'correct',
            },
          ],
          outputResultId: resultId,
          parameters: { resamples: 100, alpha: 0.05 },
        }],
      },
      comparisons: [{
        comparisonId: 'baseline-vs-candidate', controlTargetId: 'prompt-v1',
        treatmentTargetIds: ['prompt-v2'], metricIds: ['correct'],
      }],
      decisionPolicy: {
        decisionPolicyId: stableFacadeId('decision', {
          decisionKind: 'comparison', resultId,
        }),
        implementationId: 'progress/v2',
        analysisResultIds: [resultId],
        comparisonFamily: [{
          comparisonId: 'baseline-vs-candidate', treatmentTargetId: 'prompt-v2',
          metricId: 'correct', analysisResultId: resultId,
        }],
        minimumEvidenceStatus: 'complete',
        parameters: { threshold: 0, equivalence: 0 },
      },
    });

    expect(EvaluationDefinitionSchema.parse(first.definition)).toEqual(first.definition);
    expect(first.definition).toEqual(expected);
    expect(second.definition).toEqual(first.definition);
    expect(first.definition.experiment.randomizationSlots.map((slot) => slot.randomizationSlotId))
      .toEqual([
        stableFacadeId('slot', { variantId: 'prompt-v1' }),
        stableFacadeId('slot', { variantId: 'prompt-v2' }),
      ]);
    expect(first.definition.analysisGraph.nodes[0]).toMatchObject({
      nodeId: stableFacadeId('node', selector),
      outputResultId: resultId,
    });
    expect(first.definition.decisionPolicy?.decisionPolicyId).toBe(stableFacadeId('decision', {
      decisionKind: 'comparison',
      resultId: first.definition.analysisGraph.nodes[0].outputResultId,
    }));
  });

  it('preserves Executor trace, usage, and required-telemetry failures end to end', async () => {
    const declaration: Executor<string, undefined, { answer: string }, { steps: string[] }> = {
      executorId: 'test.telemetry-executor/v1',
      version: '1.0.0',
      schemas: {
        input: z.string(),
        output: z.object({ answer: z.string() }).strict(),
        trace: z.object({ steps: z.array(z.string()) }).strict(),
      },
      outputClassification: 'public',
      traceClassification: 'sensitive',
      capabilities: {
        determinism: 'deterministic',
        cancellation: 'cooperative',
        concurrency: { safety: 'parallel-safe' },
        seedControl: 'unsupported',
        telemetry: {
          trace: 'required',
          usage: 'required',
          providerCost: { reporting: 'optional' },
        },
      },
      async execute() {
        return {
          output: { answer: 'ok' },
          trace: { steps: ['done'] },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const makeVariant = (
      variantId: string,
      artifact: Variant<string, undefined, { answer: string }>['artifact'],
      boundExecutor = declaration,
    ): Variant<string, undefined, { answer: string }, { steps: string[] }> => ({
      variantId,
      artifact,
      execution: { executor: boundExecutor },
    });
    const input = {
      dataset: {
        datasetId: 'telemetry',
        samples: [{ sampleId: 'one', input: 'question', expected: { answer: 'ok' } }],
      },
      variants: [makeVariant('only', {
        name: 'candidate', kind: 'prompt', source: 'inline', content: 'Answer.',
      })],
      evaluators: [{ evaluatorKind: 'exact-match' as const }],
      comparisons: [],
      experiment: { seed: 'telemetry-seed', sampling: { samplingKind: 'solo' as const } },
      policy: {},
      runId: 'telemetry-evaluate',
      clock: fixedClock,
    };

    const result = await evaluate(input);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'completed',
      output: { classification: 'public', value: { answer: 'ok' } },
      trace: { classification: 'sensitive', value: { steps: ['done'] } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const missingTraceExecutor: typeof declaration = {
      ...declaration,
      async execute() {
        return {
          output: { answer: 'ok' },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const missingTrace = await evaluate({
      ...input,
      variants: [makeVariant('only', input.variants[0].artifact, missingTraceExecutor)],
      runId: 'telemetry-missing-trace',
    });
    expect(missingTrace.status).toBe('completed');
    if (missingTrace.status !== 'completed') return;
    expect(missingTrace.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION' },
    });
  });

  it('captures mutable Variant config and Executor callbacks before asynchronous execution', async () => {
    const declaration = executor();
    const mutable = structuredClone(treatmentSpec) as {
      variantId: string;
      artifact: typeof treatmentSpec.artifact;
      runtimeContext: { values: { model: string } };
      config: Config;
    };
    const pending = evaluate({
      ...pairedInput(declaration),
      variants: [variant(declaration, controlSpec), variant(declaration, mutable)],
      clock: fixedClock,
    });
    mutable.config.answers.one = 'mutated';
    (declaration as { execute: Executor<Input, Config, string>['execute'] }).execute = async () => ({
      output: 'mutated',
    });

    const result = await pending;
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records.filter((record) => (
      record.targetId === treatmentSpec.variantId
      && record.executionStatus === 'completed'
      && record.output?.contentKind === 'inline'
      && record.output.value === 'A'
    ))).toHaveLength(1);
  });

  it('captures Judge identity facets and method receiver before asynchronous execution', async () => {
    const seenRevisions: string[] = [];
    const mutableJudge = {
      judgeId: 'test.mutable-judge/v1',
      version: '1.0.0',
      providerCost: { reporting: 'optional' as const },
      fingerprintFacets: { deploymentRevision: 'judge-one' },
      async invoke(this: { fingerprintFacets?: { deploymentRevision?: string } }) {
        seenRevisions.push(this.fingerprintFacets?.deploymentRevision ?? 'missing');
        return { invocationStatus: 'completed' as const, output: '{"score":5,"reason":"ok"}' };
      },
    };
    const pending = evaluate({
      ...pairedInput(),
      evaluators: [{
        evaluatorKind: 'rubric-judge', evaluatorId: 'captured-judge',
        metricId: 'captured-score', model: 'judge-model', judge: mutableJudge,
        rubric: {
          criterionId: 'correctness', prompt: 'Judge correctness.',
          rubric: '5 is correct; 1 is incorrect.',
        },
      }],
      comparisons: [{
        comparisonId: 'baseline-vs-candidate', comparisonKind: 'paired',
        controlVariantId: 'prompt-v1', treatmentVariantIds: ['prompt-v2'],
        metricIds: ['captured-score'],
      }],
      decision: undefined,
      runId: 'captured-judge',
    });
    mutableJudge.fingerprintFacets.deploymentRevision = 'mutated';
    mutableJudge.invoke = async () => { throw new Error('must retain captured method'); };

    const result = await pending;
    expect(result.status).toBe('completed');
    expect(seenRevisions).toEqual(['judge-one', 'judge-one', 'judge-one', 'judge-one']);
  });

  it('keeps structured Executor failures stable and provider-private throws redacted', async () => {
    const privateMessage = 'provider-private-executor-message';
    const declaration = executor(async ({ variantId, input, config }) => {
      if (variantId === treatmentSpec.variantId) return { errorCode: 'host-capacity-exhausted' };
      if (input.prompt === 'two') throw new Error(privateMessage);
      return { output: config.answers[input.prompt] };
    });
    const result = await evaluate({ ...pairedInput(declaration), decision: undefined });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.artifacts === undefined) return;
    const failures = result.artifacts.execution.records.filter(
      (record) => record.executionStatus === 'failed',
    );
    expect(failures.map((record) => record.error.code)).toEqual(expect.arrayContaining([
      'EVAL_RUNTIME_EXECUTOR_FAILED', 'host-capacity-exhausted',
    ]));
    expect(JSON.stringify(result)).not.toContain(privateMessage);
  });

  it('maps output schema mismatches to stable redacted execution failures', async () => {
    const privateOutput = { answer: 'must-not-be-persisted' };
    const declaration = executor(async () => ({ output: privateOutput as never }));
    const result = await evaluate({
      ...pairedInput(declaration),
      evaluators: [{ evaluatorKind: 'exact-match', metricId: 'schema-safe-correct' }],
      comparisons: [{
        comparisonId: 'baseline-vs-candidate', comparisonKind: 'paired',
        controlVariantId: 'prompt-v1', treatmentVariantIds: ['prompt-v2'],
        metricIds: ['schema-safe-correct'],
      }],
      decision: undefined,
      runId: 'schema-mismatch',
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.artifacts === undefined) return;
    expect(result.artifacts.execution.records.every((record) => (
      record.executionStatus === 'failed'
      && record.error.code === 'EVAL_RUNTIME_EXECUTOR_OUTPUT_INVALID'
    ))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateOutput.answer);
  });

  it('checks a Variant-bound Executor through real success, failure, and cancellation', async () => {
    const declaration = executor(async ({ input, config, signal }) => {
      if (input.prompt === 'failure') return { errorCode: 'expected-failure' };
      if (input.prompt === 'cancellation') {
        await new Promise((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
      return { output: config.answers[input.prompt] };
    });
    const result = await checkExecutor({
      variant: variant(declaration, treatmentSpec),
      success: { input: { prompt: 'one' }, expected: 'A' },
      failure: { input: { prompt: 'failure' }, expectedErrorCode: 'expected-failure' },
      cancellation: { input: { prompt: 'cancellation' } },
    });

    expect(result.conformant, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.every((check) => check.checkStatus === 'passed')).toBe(true);
  });

  it('forwards cancellation and redacts observer failures', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    controller.abort(new Error('cancel before start'));
    const cancelled = await evaluate({
      ...pairedInput(),
      runId: 'cancelled-evaluate',
      signal: controller.signal,
    });
    expect(cancelled.status).toBe('cancelled');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));

    const privateValue = 'private-observer-payload';
    let caught: unknown;
    try {
      await evaluate({
        ...pairedInput(),
        runId: 'observer-failure',
        onEvent() { throw { privateValue }; },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvaluationEventConsumptionError);
    if (!(caught instanceof EvaluationEventConsumptionError)) return;
    expect(caught.code).toBe('EVAL_RUNTIME_EVENT_OBSERVER_FAILED');
    expect(caught.runResult?.status).toBe('completed');
    expect(JSON.stringify(caught)).not.toContain(privateValue);
  });

  it('rejects implicit designs, duplicate identities, transformed config, and the removed API', async () => {
    const declaration = executor();
    await expect(evaluate({
      ...pairedInput(declaration),
      comparisons: [],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });

    await expect(evaluate({
      ...pairedInput(declaration),
      evaluators: [
        { evaluatorKind: 'exact-match', metricId: 'same' },
        { evaluatorKind: 'exact-match', evaluatorId: 'another', metricId: 'same' },
      ],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });

    let invocations = 0;
    const transformed = {
      ...declaration,
      schemas: {
        ...declaration.schemas,
        config: z.object({ answers: z.record(z.string(), z.string()) })
          .transform((value) => ({ answers: { ...value.answers, injected: 'changed' } })),
      },
      async execute(invocation: Parameters<typeof declaration.execute>[0]) {
        invocations += 1;
        return declaration.execute(invocation);
      },
    };
    await expect(evaluate({
      ...pairedInput(transformed),
      variants: [variant(transformed, controlSpec), variant(transformed, treatmentSpec)],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });
    expect(invocations).toBe(0);

    await expect(evaluate({
      executor: declaration,
      dataset: pairedInput().dataset,
      control: controlSpec,
      treatment: treatmentSpec,
      evaluator: { evaluatorKind: 'exact-match' },
      experiment: { seed: 'removed-api' },
      policy: {},
      runId: 'removed-api',
    } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
  });

  it('rejects duplicate Variants and artifact boundary violations without leaking payloads', async () => {
    const common = pairedInput();
    await expect(evaluate({
      ...common,
      variants: [common.variants[0], { ...common.variants[1], variantId: 'prompt-v1' }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });

    const privatePayload = 'must-not-appear-in-error';
    let failure: unknown;
    try {
      await evaluate({
        ...common,
        variants: [{
          ...common.variants[0],
          artifact: { ...common.variants[0].artifact, content: privatePayload },
        }, common.variants[1]],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });
    expect(String(failure)).not.toContain(privatePayload);
  });

  it('rejects runtime-context boundary confusion and invalid Decision selectors', async () => {
    const common = pairedInput();
    await expect(evaluate({
      ...common,
      variants: [common.variants[0], {
        ...common.variants[1],
        execution: {
          ...common.variants[1].execution,
          runtimeContext: { cwd: '/tmp/unsealed-workspace' },
        },
      }],
    } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });

    await expect(evaluate({
      ...common,
      decision: {
        decisionKind: 'comparison',
        comparisonId: 'baseline-vs-candidate',
        treatmentVariantId: 'missing-variant',
        metricId: 'correct',
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
  });

  it('derives a bounded evaluator identity from the longest valid Metric identity', async () => {
    const metricId = 'm'.repeat(256);
    const result = await evaluate({
      dataset: {
        datasetId: 'long-metric-id',
        samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
      },
      variants: [variant(executor(), treatmentSpec)],
      evaluators: [{ evaluatorKind: 'exact-match', metricId }],
      comparisons: [],
      experiment: { seed: 'long-metric-id', sampling: { samplingKind: 'solo' } },
      policy: {},
      runId: 'long-metric-id',
    });

    expect(result.status).toBe('completed');
    expect(result.definition.evaluators[0].evaluatorId).toMatch(/^exact-match:[0-9a-f]{64}$/);
    expect(result.definition.metrics[0].metricId).toBe(metricId);
  });
});
