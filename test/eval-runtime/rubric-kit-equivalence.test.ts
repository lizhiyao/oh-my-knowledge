import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  createEvaluationRuntime,
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
  createMeasurementPolicy,
  createPairedComparisonDefinition,
  createRubricJudgeKit,
  createRuntimeIdentity,
  runEvaluation,
  type OmkLlmJudgeInvocationPort,
} from '../../src/eval-runtime/index.js';
import {
  createRubricJudgeCriterion,
  createRubricJudgeEvaluatorDefinition,
  createRubricJudgeEvaluatorRegistration,
  createRubricJudgeInstrument,
  createRubricJudgeMetricDefinition,
  createRubricJudgeRuntimeConfig,
} from '../../src/eval-runtime/advanced.js';

const clock = {
  monotonicNow: () => 1,
  timestamp: () => '2026-09-04T00:00:00.000Z',
  sleep: () => Promise.resolve(),
};

function targetIdentity() {
  return createInvokeExecutorIdentity({
    implementationId: 'test.rubric-target/v1',
    version: '1.0.0',
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'required' },
    fingerprintFacets: { revision: 'target-one' },
  });
}

function judgeIdentity() {
  return createRuntimeIdentity({
    implementationId: 'test.rubric-gateway/v1',
    version: '1.0.0',
    capabilities: { invocation: 'single-call', cancellation: 'cooperative' },
    fingerprintFacets: { revision: 'gateway-one' },
  });
}

function fixture(mode: 'manual' | 'kit', providerFailure = false) {
  const target = targetIdentity();
  const requests: Array<Readonly<{
    system: string;
    prompt: string;
    promptId: string;
    promptHash: string;
  }>> = [];
  const invocation: OmkLlmJudgeInvocationPort = {
    identity: judgeIdentity(),
    providerCost: { reporting: 'optional' },
    async invoke(request) {
      requests.push({
        system: request.system,
        prompt: request.prompt,
        promptId: request.promptId,
        promptHash: request.promptHash,
      });
      if (providerFailure) {
        return {
          invocationStatus: 'failed',
          reasonCode: 'private-provider-category',
          usage: {
            inputTokens: 8,
            providerCost: { amount: 0.002, currency: 'USD', reportedByProvider: true },
            details: { privateTenant: 'must-be-redacted' },
          },
        };
      }
      return {
        invocationStatus: 'completed',
        output: '{"reasoning":"same","score":5,"reason":"correct"}',
        usage: {
          inputTokens: 8,
          outputTokens: 4,
          totalTokens: 12,
          providerCost: { amount: 0.002, currency: 'USD', reportedByProvider: true },
        },
      };
    },
  };
  const instrument = createRubricJudgeInstrument({ lengthDebias: false });
  const judgeRuntime = createRubricJudgeRuntimeConfig({
    executorId: invocation.identity.implementationId,
    model: 'judge-model',
    effort: 'low',
    instrument,
  });
  const manualCriterion = createRubricJudgeCriterion({
    criterionId: 'correctness',
    prompt: 'Capital of France?',
    rubric: 'The output must state Paris.',
  });
  const kit = createRubricJudgeKit({
    evaluatorId: 'correctness-judge',
    metricId: 'correctness-score',
    model: 'judge-model',
    effort: 'low',
    invocation,
    lengthDebias: false,
  });
  const evaluator = mode === 'kit' ? kit.evaluatorDefinition : createRubricJudgeEvaluatorDefinition({
    evaluatorId: 'correctness-judge',
    metricId: 'correctness-score',
    instrument,
    runtime: judgeRuntime,
    criterionPointer: '/rubricJudge/correctness-judge',
  });
  const metric = mode === 'kit'
    ? kit.metricDefinition
    : createRubricJudgeMetricDefinition('correctness-score');
  const criterion = mode === 'kit'
    ? kit.createCriterion({
      criterionId: 'correctness',
      prompt: 'Capital of France?',
      rubric: 'The output must state Paris.',
    })
    : manualCriterion;
  const evaluationContext = mode === 'kit'
    ? kit.createEvaluationContext(criterion)
    : { rubricJudge: { 'correctness-judge': criterion } };
  const registration = mode === 'kit'
    ? kit.evaluatorRegistration
    : createRubricJudgeEvaluatorRegistration([{
      evaluatorId: 'correctness-judge',
      instrument,
      runtime: judgeRuntime,
      invocation,
    }]);
  const definition = createPairedComparisonDefinition({
    datasetId: 'rubric-equivalence',
    seed: 'rubric-equivalence-seed',
    samples: ['one', 'two'].map((sampleId) => ({
      sampleId,
      input: { prompt: sampleId },
      expected: 'Paris',
      evaluationContext,
    })),
    control: { targetId: 'control', executorId: target.implementationId },
    treatment: { targetId: 'treatment', executorId: target.implementationId },
    evaluator,
    metric,
    bootstrap: { resamples: 100 },
  });
  const createTarget = () => createJsonExecutorAdapter({
    identity: target,
    inputParser: z.object({ prompt: z.string() }).strict(),
    targetConfigParser: z.undefined(),
    outputParser: z.string(),
    outputClassification: 'public',
    async invoke() {
      return {
        invocationStatus: 'completed',
        output: 'Paris',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  });
  const runtime = createEvaluationRuntime({
    executors: [{ implementationId: target.implementationId, createPort: createTarget }],
    evaluators: [registration],
    clock,
  });
  return { definition, runtime, requests, kit, instrument };
}

describe('Rubric Judge kit equivalence', () => {
  it.each([false, true])(
    'matches manual assembly for prompt, identity, artifacts, usage and provider failure=%s',
    async (providerFailure) => {
      const manual = fixture('manual', providerFailure);
      const kit = fixture('kit', providerFailure);
      expect(kit.definition).toEqual(manual.definition);
      expect(kit.kit.instrument).toEqual(manual.instrument);

      const [manualResult, kitResult] = await Promise.all([
        runEvaluation({
          runtime: manual.runtime,
          definition: manual.definition,
          policy: createMeasurementPolicy(),
          runId: 'rubric-equivalence-run',
        }),
        runEvaluation({
          runtime: kit.runtime,
          definition: kit.definition,
          policy: createMeasurementPolicy(),
          runId: 'rubric-equivalence-run',
        }),
      ]);

      expect(kit.requests).toEqual(manual.requests);
      expect(kitResult).toEqual(manualResult);
      expect(kit.requests.every((request) => (
        request.promptId === kit.kit.instrument.promptId
        && request.promptHash === kit.kit.instrument.promptHash
      ))).toBe(true);
      if (providerFailure) {
        expect(JSON.stringify(kitResult)).not.toContain('privateTenant');
        expect(JSON.stringify(kitResult)).not.toContain('private-provider-category');
      }
    },
  );

  it('keeps source-neutral trace opt-in explicit and forwards Judge cancellation', async () => {
    const controller = new AbortController();
    let judgeSignal: AbortSignal | undefined;
    const invocation: OmkLlmJudgeInvocationPort = {
      identity: judgeIdentity(),
      providerCost: { reporting: 'unsupported' },
      async invoke(request) {
        judgeSignal = request.signal;
        controller.abort();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(request.signal.reason);
          if (request.signal.aborted) abort();
          else request.signal.addEventListener('abort', abort, { once: true });
        });
        return { invocationStatus: 'completed', output: '{}' };
      },
    };
    const traceJudge = createRubricJudgeKit({
      evaluatorId: 'cancel-judge',
      metricId: 'cancel-score',
      model: 'judge-model',
      invocation,
      tracePolicy: 'source-neutral',
    });
    expect(traceJudge.evaluatorDefinition.inputs.map((binding) => binding.sourceKind)).toEqual([
      'output',
      'evaluation-context',
      'trace',
    ]);

    const cancelJudge = createRubricJudgeKit({
      evaluatorId: 'cancel-judge',
      metricId: 'cancel-score',
      model: 'judge-model',
      invocation,
    });
    const criterion = cancelJudge.createCriterion({
      criterionId: 'correctness',
      prompt: 'Capital of France?',
      rubric: 'The output must state Paris.',
    });
    const target = targetIdentity();
    const definition = createPairedComparisonDefinition({
      datasetId: 'rubric-cancellation',
      seed: 'rubric-cancellation-seed',
      samples: ['one', 'two'].map((sampleId) => ({
        sampleId,
        input: { prompt: sampleId },
        expected: 'Paris',
        evaluationContext: cancelJudge.createEvaluationContext(criterion),
      })),
      control: { targetId: 'control', executorId: target.implementationId },
      treatment: { targetId: 'treatment', executorId: target.implementationId },
      evaluator: cancelJudge.evaluatorDefinition,
      metric: cancelJudge.metricDefinition,
      bootstrap: { resamples: 100 },
    });
    const runtime = createEvaluationRuntime({
      executors: [{
        implementationId: target.implementationId,
        createPort: () => createJsonExecutorAdapter({
          identity: target,
          inputParser: z.object({ prompt: z.string() }).strict(),
          targetConfigParser: z.undefined(),
          outputParser: z.string(),
          outputClassification: 'public',
          async invoke() {
            return {
              invocationStatus: 'completed',
              output: 'Paris',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      }],
      evaluators: [cancelJudge.evaluatorRegistration],
      clock,
    });
    const result = await runEvaluation({
      runtime,
      definition,
      policy: createMeasurementPolicy(),
      runId: 'rubric-cancellation',
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(judgeSignal?.aborted).toBe(true);
  });
});
