import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { digestCanonicalJson, type JsonValue } from '../../src/eval-core/contracts/index.js';
import {
  EvaluationConfigurationError,
  evaluate,
  prepareEvaluation,
  type ContentResolver,
  type ContentStore,
  type ContentValue,
  type CustomEvaluator,
  type Executor,
} from '../../src/eval-runtime/index.js';

function executor(): Executor<string, undefined, string> {
  return {
    executorId: 'test.content-executor/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: z.string() },
    outputClassification: 'sensitive',
    capabilities: { determinism: 'deterministic' },
    async execute({ signal }) {
      signal.throwIfAborted();
      return { output: 'answer' };
    },
  };
}

function evaluator(): CustomEvaluator<{ actual: string }> {
  return {
    evaluatorKind: 'custom',
    evaluatorId: 'content-evaluator',
    instrumentId: 'content-evaluator-v1',
    metric: {
      metricId: 'content-score',
      valueType: 'numeric',
      scale: { min: 0, max: 1 },
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    },
    bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
    implementation: {
      implementationId: 'test.content-evaluator/v1',
      version: '1.0.0',
      schemas: {
        bindings: z.object({ actual: z.string() }).strict(),
        value: z.number(),
        fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
      },
      fingerprintFacets: { revision: 'one' },
      evaluate({ bindings }) {
        return {
          resultKind: 'score',
          value: bindings.actual === 'answer' ? 1 : 0,
          evidence: {
            value: { explanation: 'resolved-output-matched' },
            classification: 'sensitive',
          },
        };
      },
    },
  };
}

function evaluationInput(
  policy: Record<string, unknown> = {},
  infrastructure?: Readonly<{ contentStore?: ContentStore; contentResolver?: ContentResolver }>,
) {
  return {
    dataset: {
      datasetId: 'content-infrastructure',
      samples: [{ sampleId: 'one', input: 'question', expected: 'answer' }],
    },
    variants: [{
      variantId: 'content-variant',
      artifact: {
        name: 'content-prompt',
        kind: 'prompt' as const,
        source: 'inline' as const,
        content: 'Answer.',
      },
      execution: { executor: executor() },
    }],
    evaluators: [evaluator()],
    comparisons: [],
    analyses: [{
      analysisId: 'content-summary',
      analysisKind: 'summary' as const,
      statistic: 'mean' as const,
      variantId: 'content-variant',
      metricId: 'content-score',
    }],
    experiment: { seed: 'content-seed', sampling: { samplingKind: 'solo' as const } },
    policy,
    ...(infrastructure === undefined ? {} : { infrastructure }),
  };
}

function inMemoryContentPorts() {
  const values = new Map<string, ContentValue>();
  const stored: JsonValue[] = [];
  const resolved: string[] = [];
  const contentStore: ContentStore & { calls: number } = {
    calls: 0,
    async put(request) {
      this.calls += 1;
      stored.push(structuredClone(request.value));
      values.set(request.digest, {
        value: structuredClone(request.value),
        classification: request.classification,
        mediaType: request.mediaType,
      });
      return {
        digest: request.digest,
        mediaType: request.mediaType,
        size: JSON.stringify(request.value).length,
      };
    },
  };
  const contentResolver: ContentResolver & { calls: number } = {
    calls: 0,
    async resolve(descriptor) {
      this.calls += 1;
      resolved.push(descriptor.digest);
      const value = values.get(descriptor.digest);
      if (value === undefined) throw new Error('private missing content path');
      return structuredClone(value);
    },
  };
  return { contentStore, contentResolver, stored, resolved };
}

describe('eval-runtime content infrastructure', () => {
  it('materializes all evidence defaults before execution', async () => {
    const prepared = await prepareEvaluation(evaluationInput());
    expect(prepared.policy.evidence).toEqual({
      output: 'full',
      trace: 'full',
      evidence: 'full',
      maximumClassification: 'gold',
    });
  });

  it('round-trips reference output into an Evaluator and stores Evaluator evidence', async () => {
    const ports = inMemoryContentPorts();
    const result = await evaluate(evaluationInput({
      evidence: {
        output: 'reference',
        trace: 'none',
        evaluatorEvidence: 'reference',
        maximumClassification: 'sensitive',
      },
    }, {
      contentStore: ports.contentStore,
      contentResolver: ports.contentResolver,
    }), { runId: 'content-reference' });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.analysisResults['content-summary']).toMatchObject({ value: 1 });
    expect(ports.contentStore.calls).toBe(2);
    expect(ports.contentResolver.calls).toBe(1);
    expect(ports.stored).toEqual([
      'answer',
      { explanation: 'resolved-output-matched' },
    ]);
    const output = result.artifacts?.execution?.records[0];
    expect(output).toMatchObject({
      executionStatus: 'completed',
      output: {
        contentKind: 'descriptor',
        classification: 'sensitive',
        descriptor: { digest: digestCanonicalJson('answer'), mediaType: 'application/json' },
      },
    });
    expect(result.artifacts?.evaluation?.records[0]).toMatchObject({
      evaluationStatus: 'completed',
      observations: [{
        observationStatus: 'observed',
        evidence: {
          contentKind: 'descriptor',
          classification: 'sensitive',
        },
      }],
    });
  });

  it('captures port methods during prepare instead of re-reading mutable declarations', async () => {
    const ports = inMemoryContentPorts();
    const prepared = await prepareEvaluation(evaluationInput({
      evidence: { output: 'reference' },
    }, {
      contentStore: ports.contentStore,
      contentResolver: ports.contentResolver,
    }));
    const replacementPut = vi.fn<ContentStore['put']>();
    const replacementResolve = vi.fn<ContentResolver['resolve']>();
    ports.contentStore.put = replacementPut;
    ports.contentResolver.resolve = replacementResolve;

    const result = await prepared.run({ runId: 'captured-content-ports' });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(ports.contentStore.calls).toBe(1);
    expect(ports.contentResolver.calls).toBe(1);
    expect(replacementPut).not.toHaveBeenCalled();
    expect(replacementResolve).not.toHaveBeenCalled();
  });

  it('fails during prepare when reference capture lacks required host ports', async () => {
    await expect(prepareEvaluation(evaluationInput({
      evidence: { output: 'reference' },
    }))).rejects.toEqual(expect.objectContaining({
      code: 'EVAL_RUNTIME_INPUT_INVALID',
    } satisfies Partial<EvaluationConfigurationError>));

    const ports = inMemoryContentPorts();
    await expect(prepareEvaluation(evaluationInput({
      evidence: { output: 'reference' },
    }, { contentStore: ports.contentStore }))).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_INPUT_INVALID',
    });

    await expect(prepareEvaluation(evaluationInput({
      evidence: { evaluatorEvidence: 'reference' },
    }, { contentResolver: ports.contentResolver }))).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_INPUT_INVALID',
    });
  });

  it('rejects capture modes that remove a declared Evaluator input', async () => {
    await expect(prepareEvaluation(evaluationInput({
      evidence: { output: 'digest' },
    }))).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    await expect(prepareEvaluation(evaluationInput({
      evidence: { output: 'none' },
    }))).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    await expect(prepareEvaluation(evaluationInput({
      evidence: { maximumClassification: 'public' },
    }))).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
  });

  it('fails closed on invalid infrastructure declarations and forged resolved content', async () => {
    await expect(prepareEvaluation({
      ...evaluationInput(),
      infrastructure: { contentStore: {} },
    } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });

    const ports = inMemoryContentPorts();
    const forgedResolver: ContentResolver = {
      async resolve() {
        return { value: 'forged', classification: 'sensitive', mediaType: 'application/json' };
      },
    };
    const result = await evaluate(evaluationInput({
      evidence: { output: 'reference' },
    }, { contentStore: ports.contentStore, contentResolver: forgedResolver }));

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('private missing content path');

    const rejectedSecret = 'private signed storage locator';
    const throwingStore: ContentStore = {
      async put() {
        throw new Error(rejectedSecret);
      },
    };
    const storeFailure = await evaluate(evaluationInput({
      evidence: { output: 'reference' },
    }, { contentStore: throwingStore, contentResolver: ports.contentResolver }));

    expect(storeFailure.status).toBe('failed');
    expect(JSON.stringify(storeFailure)).not.toContain(rejectedSecret);
  });
});
