import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeJsonBytes,
  digestCanonicalJson,
  type JsonValue,
} from '../../src/eval-core/contracts/index.js';
import {
  EXECUTED_EVALUATION_MEDIA_TYPE,
  EVALUATION_RESULT_MEDIA_TYPE,
  EvaluationConfigurationError,
  EvaluationResultStoreError,
  ExecutedEvaluationStoreError,
  evaluate,
  executeEvaluation,
  loadEvaluationResult,
  loadExecutedEvaluation,
  prepareEvaluation,
  reanalyze,
  rescore,
  saveEvaluationResult,
  saveExecutedEvaluation,
  scoreExecutedEvaluation,
  type ContentDescriptor,
  type ContentResolver,
  type ContentStore,
  type ContentValue,
  type CustomEvaluator,
  type ExecutedEvaluation,
  type ExecutedEvaluationVerification,
  type EvaluationResult,
  type EvaluationResultVerification,
  type Executor,
} from '../../src/eval-runtime/index.js';

function executor(targetCalls?: string[]): Executor<string, undefined, string> {
  return {
    executorId: 'test.content-executor/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: z.string() },
    outputClassification: 'sensitive',
    capabilities: { determinism: 'deterministic' },
    async execute({ signal }) {
      signal.throwIfAborted();
      targetCalls?.push('execute');
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
  targetCalls?: string[],
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
      execution: { executor: executor(targetCalls) },
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
        size: canonicalizeJsonBytes(request.value).byteLength,
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
  return { contentStore, contentResolver, stored, resolved, values };
}

function verificationFor(
  result: EvaluationResult,
  verifiedResultDigest: string,
): EvaluationResultVerification {
  const artifacts = result.artifacts!;
  const records = [
    ...artifacts.execution!.records,
    ...artifacts.evaluation!.records,
  ];
  return {
    verifiedResultDigest,
    attestationDigest: digestCanonicalJson(['attested', verifiedResultDigest]),
    verifiedProvenanceBundleDigests: [
      artifacts.execution!.bundleDigest,
      artifacts.evaluation!.bundleDigest,
      artifacts.analysis!.bundleDigest,
    ],
    verifiedCacheRecordDigests: records.flatMap((record) => {
      const digest = 'cache' in record ? record.cache.sourceRecordDigest : undefined;
      return digest === undefined ? [] : [digest];
    }),
    verifiedPolicyExecutionDigests: artifacts.decision === undefined
      ? []
      : [artifacts.decision.decisionDigest],
  };
}

describe('eval-runtime content infrastructure', () => {
  it('persists, resolves, and re-admits a canonical result for stage reuse', async () => {
    const ports = inMemoryContentPorts();
    const sourceCalls: string[] = [];
    const source = await evaluate(evaluationInput({}, undefined, sourceCalls), {
      runId: 'stored-result-source',
      clock: {
        monotonicNow: () => 0,
        timestamp: () => '2026-09-05T00:00:00.000Z',
        sleep: () => Promise.resolve(),
      },
    });
    expect(sourceCalls).toEqual(['execute']);
    const reference = await saveEvaluationResult({ result: source, store: ports.contentStore });

    expect(reference.mediaType).toBe(EVALUATION_RESULT_MEDIA_TYPE);
    const stored = ports.values.get(reference.digest);
    expect(stored?.classification).toBe('gold');
    const restoredCalls: string[] = [];
    const prepared = await prepareEvaluation(evaluationInput({}, undefined, restoredCalls));
    const restored = await loadEvaluationResult({
      prepared,
      reference: structuredClone(reference),
      resolver: ports.contentResolver,
      verifier: {
        verifierId: 'test.result-verifier/v1',
        async verify({ reference: candidate }) {
          return verificationFor(source, candidate.digest);
        },
      },
    });

    expect(restored).toEqual(source);
    expect(restored).not.toBe(source);
    expect(restoredCalls).toEqual([]);

    const changed = evaluationInput({}, undefined, restoredCalls);
    changed.dataset.samples[0].expected = 'different';
    const rescored = await rescore(changed, restored, { runId: 'stored-result-rescored' });
    expect(rescored.status).toBe('completed');
    expect(rescored.artifacts?.execution).toBe(restored.artifacts?.execution);
    expect(rescored.artifacts?.evaluation?.bundleDigest)
      .not.toBe(restored.artifacts?.evaluation?.bundleDigest);
    expect(restoredCalls).toEqual([]);

    const reanalyzed = await reanalyze({
      ...changed,
      analyses: [{ ...changed.analyses[0], statistic: 'quantile' as const, probability: 0.5 }],
    }, rescored, { runId: 'stored-result-reanalyzed' });
    expect(reanalyzed.status).toBe('completed');
    expect(reanalyzed.artifacts?.execution).toBe(rescored.artifacts?.execution);
    expect(reanalyzed.artifacts?.evaluation).toBe(rescored.artifacts?.evaluation);
    expect(reanalyzed.artifacts?.analysis?.bundleDigest)
      .not.toBe(rescored.artifacts?.analysis?.bundleDigest);
    expect(restoredCalls).toEqual([]);
    expect(sourceCalls).toEqual(['execute']);
  });

  it('rejects cloned sources, mismatched plans, and tampered stored content', async () => {
    const ports = inMemoryContentPorts();
    const source = await evaluate(evaluationInput(), { runId: 'stored-result-validation' });
    await expect(saveEvaluationResult({
      result: structuredClone(source),
      store: ports.contentStore,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_NOT_CANONICAL' });

    const reference = await saveEvaluationResult({ result: source, store: ports.contentStore });
    const changed = evaluationInput();
    changed.dataset.samples[0].expected = 'different';
    await expect(loadEvaluationResult({
      prepared: await prepareEvaluation(changed),
      reference,
      resolver: ports.contentResolver,
      verifier: null as never,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_PLAN_MISMATCH' });

    const stored = ports.values.get(reference.digest);
    expect(stored).toBeDefined();
    ports.values.set(reference.digest, {
      ...structuredClone(stored!),
      value: { ...(structuredClone(stored!.value) as Record<string, JsonValue>), planDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    await expect(loadEvaluationResult({
      prepared: await prepareEvaluation(evaluationInput()),
      reference,
      resolver: ports.contentResolver,
      verifier: null as never,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_CONTENT_INVALID' });
  });

  it('keeps the requested reference immutable across a hostile resolver call', async () => {
    const ports = inMemoryContentPorts();
    const first = await evaluate(evaluationInput(), { runId: 'stored-result-first' });
    const second = await evaluate(evaluationInput(), { runId: 'stored-result-second' });
    const firstReference = await saveEvaluationResult({
      result: first,
      store: ports.contentStore,
    });
    const secondReference = await saveEvaluationResult({
      result: second,
      store: ports.contentStore,
    });
    const secondContent = ports.values.get(secondReference.digest)!;

    await expect(loadEvaluationResult({
      prepared: await prepareEvaluation(evaluationInput()),
      reference: firstReference,
      resolver: {
        async resolve(reference) {
          try {
            (reference as { digest: string }).digest = secondReference.digest;
          } catch {
            // A strict host observes the frozen reference; either way it returns the wrong value.
          }
          return structuredClone(secondContent);
        },
      },
      verifier: null as never,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_CONTENT_INVALID' });
    expect(firstReference.digest).not.toBe(secondReference.digest);
  });

  it('rejects tampered artifacts even when host storage and verifier accept their new digest', async () => {
    const ports = inMemoryContentPorts();
    const source = await evaluate(evaluationInput(), { runId: 'stored-result-core-admission' });
    const originalReference = await saveEvaluationResult({
      result: source,
      store: ports.contentStore,
    });
    const original = ports.values.get(originalReference.digest)!;
    const envelope = structuredClone(original.value) as Record<string, JsonValue>;
    const result = envelope.result as Record<string, JsonValue>;
    result.runId = 'tampered-run-id';
    const tamperedDigest = digestCanonicalJson(envelope);
    ports.values.set(tamperedDigest, { ...original, value: envelope });
    const reference = {
      mediaType: EVALUATION_RESULT_MEDIA_TYPE,
      digest: tamperedDigest,
    };

    await expect(loadEvaluationResult({
      prepared: await prepareEvaluation(evaluationInput()),
      reference,
      resolver: ports.contentResolver,
      verifier: {
        verifierId: 'test.permissive-result-verifier/v1',
        async verify({ reference: candidate }) {
          return verificationFor(source, candidate.digest);
        },
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_CONTENT_INVALID' });
  });

  it('redacts host store and resolver failures', async () => {
    const source = await evaluate(evaluationInput(), { runId: 'stored-result-redaction' });
    let storeError: unknown;
    try {
      await saveEvaluationResult({
        result: source,
        store: { put: async () => { throw new Error('private store path'); } },
      });
    } catch (error) {
      storeError = error;
    }
    expect(storeError).toBeInstanceOf(EvaluationResultStoreError);
    expect((storeError as Error).message).not.toContain('private store path');

    const ports = inMemoryContentPorts();
    const reference = await saveEvaluationResult({ result: source, store: ports.contentStore });
    let resolveError: unknown;
    try {
      await loadEvaluationResult({
        prepared: await prepareEvaluation(evaluationInput()),
        reference,
        resolver: { resolve: async () => { throw new Error('private database credential'); } },
        verifier: null as never,
      });
    } catch (error) {
      resolveError = error;
    }
    expect(resolveError).toBeInstanceOf(EvaluationResultStoreError);
    expect((resolveError as Error).message).not.toContain('private database credential');

    let verifierError: unknown;
    try {
      await loadEvaluationResult({
        prepared: await prepareEvaluation(evaluationInput()),
        reference,
        resolver: ports.contentResolver,
        verifier: {
          verifierId: 'test.failing-result-verifier/v1',
          verify: async () => { throw new Error('private signing-key path'); },
        },
      });
    } catch (error) {
      verifierError = error;
    }
    expect(verifierError).toBeInstanceOf(EvaluationResultStoreError);
    expect(verifierError).toMatchObject({ code: 'EVAL_RUNTIME_RESULT_VERIFICATION_FAILED' });
    expect((verifierError as Error).message).not.toContain('private signing-key path');

    await expect(loadEvaluationResult({
      prepared: await prepareEvaluation(evaluationInput()),
      reference,
      resolver: ports.contentResolver,
      verifier: {
        verifierId: 'test.wrong-result-verifier/v1',
        async verify() {
          return {
            verifiedResultDigest:
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            attestationDigest:
              'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            verifiedProvenanceBundleDigests: [],
            verifiedCacheRecordDigests: [],
            verifiedPolicyExecutionDigests: [],
          };
        },
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_VERIFICATION_FAILED' });

    const throwingValue = (secret: string) => {
      const value = {} as Record<string, unknown>;
      Object.defineProperty(value, 'digest', {
        enumerable: true,
        get() { throw new Error(secret); },
      });
      return value;
    };
    await expect(saveEvaluationResult({
      result: source,
      store: { put: async () => throwingValue('private descriptor token') as never },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_STORE_FAILED' });

    await expect(loadEvaluationResult({
      prepared: await prepareEvaluation(evaluationInput()),
      reference,
      resolver: { resolve: async () => throwingValue('private resolver token') as never },
      verifier: null as never,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_RESOLVE_FAILED' });

    await expect(loadEvaluationResult({
      prepared: await prepareEvaluation(evaluationInput()),
      reference,
      resolver: ports.contentResolver,
      verifier: {
        verifierId: 'test.getter-result-verifier/v1',
        verify: async () => throwingValue('private verifier token') as never,
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_VERIFICATION_FAILED' });
  });

  it('rejects a canonical failure without a complete artifact chain before store I/O', async () => {
    const result = await evaluate(evaluationInput(), {
      runId: 'stored-result-incomplete',
      clock: {
        monotonicNow() { throw new Error('clock unavailable'); },
        timestamp: () => '2026-09-05T00:00:00.000Z',
        sleep: () => Promise.resolve(),
      },
    });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.artifacts).toBeUndefined();
    const put = vi.fn<ContentStore['put']>();
    await expect(saveEvaluationResult({ result, store: { put } }))
      .rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_NOT_CANONICAL' });
    expect(put).not.toHaveBeenCalled();
  });

  it('seals canonical artifact slots before returning a result', async () => {
    const source = await evaluate(evaluationInput(), { runId: 'stored-result-sealed-artifact' });
    const foreign = await evaluate(evaluationInput(), { runId: 'stored-result-foreign-artifact' });
    expect(Object.isFrozen(source.artifacts)).toBe(true);
    expect(source.artifacts?.evaluation).toBeDefined();
    expect(foreign.artifacts?.evaluation).toBeDefined();
    expect(Reflect.deleteProperty(source.artifacts!, 'evaluation')).toBe(false);
    expect(() => {
      (source.artifacts as { evaluation?: unknown }).evaluation = foreign.artifacts?.evaluation;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(source.artifacts, 'evaluation', {
      configurable: true,
      enumerable: true,
      get: () => foreign.artifacts?.evaluation,
    })).toThrow(TypeError);

    const ports = inMemoryContentPorts();
    await expect(saveEvaluationResult({ result: source, store: ports.contentStore }))
      .resolves.toMatchObject({ mediaType: EVALUATION_RESULT_MEDIA_TYPE });
    expect(ports.stored).toHaveLength(1);
  });

  it('requires every reference-captured evidence value to remain resolvable', async () => {
    const ports = inMemoryContentPorts();
    const input = evaluationInput({
      evidence: { output: 'reference', trace: 'none' },
    }, {
      contentStore: ports.contentStore,
      contentResolver: ports.contentResolver,
    });
    const result = await evaluate(input, { runId: 'stored-result-reference-closure' });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    const record = result.artifacts.execution.records[0];
    const output = record.executionStatus === 'completed' ? record.output : undefined;
    expect(output?.contentKind).toBe('descriptor');
    if (output?.contentKind !== 'descriptor') return;
    const reference = await saveEvaluationResult({ result, store: ports.contentStore });
    ports.values.delete(output.descriptor.digest);

    await expect(loadEvaluationResult({
      prepared: await prepareEvaluation(input),
      reference,
      resolver: ports.contentResolver,
      verifier: {
        verifierId: 'test.reference-closure-verifier/v1',
        async verify({ reference: candidate }) {
          return verificationFor(result, candidate.digest);
        },
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RESULT_RESOLVE_FAILED' });
  });

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

function executedVerificationFor(
  bundle: ExecutedEvaluation['bundle'],
  verifiedExecutedDigest: string,
  attested: boolean,
): ExecutedEvaluationVerification {
  return {
    verifiedExecutedDigest,
    attestationDigest: digestCanonicalJson(['attested', verifiedExecutedDigest]),
    verifiedProvenanceBundleDigests: attested ? [bundle.bundleDigest] : [],
    verifiedCacheRecordDigests: bundle.records.flatMap((record) => {
      const digest = 'cache' in record ? record.cache.sourceRecordDigest : undefined;
      return digest === undefined ? [] : [digest];
    }),
  };
}

describe('eval-runtime executed evaluation store', () => {
  async function reload(
    ports: ReturnType<typeof inMemoryContentPorts>,
    reference: ContentDescriptor,
    executed: ExecutedEvaluation,
    attested = true,
  ): Promise<ExecutedEvaluation> {
    return loadExecutedEvaluation({
      reference,
      resolver: ports.contentResolver,
      verifier: {
        verifierId: 'test.executed-verifier/v1',
        async verify({ reference: candidate }) {
          return executedVerificationFor(executed.bundle, candidate.digest, attested);
        },
      },
    });
  }

  it('persists one execution envelope and re-admits it for scoring without a Target call', async () => {
    const ports = inMemoryContentPorts();
    const sourceCalls: string[] = [];
    const executed = await executeEvaluation(
      evaluationInput({}, undefined, sourceCalls),
      { runId: 'staged-store-source' },
    );
    expect(sourceCalls).toEqual(['execute']);

    const reference = await saveExecutedEvaluation({
      executed,
      store: ports.contentStore,
    });

    expect(reference.mediaType).toBe(EXECUTED_EVALUATION_MEDIA_TYPE);
    expect(ports.values.get(reference.digest)?.classification).toBe('gold');

    const restoredCalls: string[] = [];
    const loaded = await reload(ports, structuredClone(reference), executed);

    expect(loaded.bundleOrigin).toBe('store');
    expect(loaded.runId).toBe('staged-store-source');
    expect(loaded.bundle).toEqual(executed.bundle);
    expect(loaded.bundle).not.toBe(executed.bundle);

    const changed = evaluationInput({}, undefined, restoredCalls);
    changed.dataset.samples[0].expected = 'different';
    const scored = await scoreExecutedEvaluation(changed, loaded, {
      runId: 'staged-store-scored',
    });

    expect(scored.status).toBe('completed');
    expect(scored.artifacts?.execution?.bundleDigest).toBe(executed.bundle.bundleDigest);
    expect(restoredCalls).toEqual([]);
    expect(sourceCalls).toEqual(['execute']);
  });

  it('keeps a host attestation from upgrading what an unverified envelope may claim', async () => {
    const ports = inMemoryContentPorts();
    const executed = await executeEvaluation(evaluationInput(), {
      runId: 'staged-store-trust',
    });
    const reference = await saveExecutedEvaluation({
      executed,
      store: ports.contentStore,
    });

    const attested = await reload(ports, reference, executed, true);
    const unattested = await reload(ports, reference, executed, false);
    const attestedResult = await scoreExecutedEvaluation(evaluationInput(), attested, {
      runId: 'staged-store-attested',
    });
    const unattestedResult = await scoreExecutedEvaluation(evaluationInput(), unattested, {
      runId: 'staged-store-unattested',
    });

    expect(attestedResult.report?.provenance.trust).toBe('declared');
    expect(unattestedResult.report?.provenance.trust).toBe('unknown');
    expect(attestedResult.artifacts?.execution?.bundleDigest)
      .toBe(executed.bundle.bundleDigest);
    expect(unattestedResult.artifacts?.execution?.bundleDigest)
      .toBe(executed.bundle.bundleDigest);
  });

  it('rejects a handle that is not canonical, a foreign reference, and a mismatched attestation', async () => {
    const ports = inMemoryContentPorts();
    const executed = await executeEvaluation(evaluationInput(), {
      runId: 'staged-store-rejections',
    });

    await expect(saveExecutedEvaluation({
      executed: structuredClone(executed),
      store: ports.contentStore,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EXECUTED_NOT_CANONICAL' });
    await expect(saveExecutedEvaluation({
      executed: { ...structuredClone(executed), bundleOrigin: 'store' },
      store: ports.contentStore,
    } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EXECUTED_NOT_CANONICAL' });

    const reference = await saveExecutedEvaluation({
      executed,
      store: ports.contentStore,
    });
    await expect(loadExecutedEvaluation({
      reference: { ...reference, mediaType: EVALUATION_RESULT_MEDIA_TYPE },
      resolver: ports.contentResolver,
      verifier: {
        verifierId: 'test.executed-verifier/v1',
        async verify({ reference: candidate }) {
          return executedVerificationFor(executed.bundle, candidate.digest, true);
        },
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EXECUTED_REFERENCE_INVALID' });

    await expect(loadExecutedEvaluation({
      reference,
      resolver: ports.contentResolver,
      verifier: {
        verifierId: 'test.wrong-executed-verifier/v1',
        async verify() {
          return executedVerificationFor(
            executed.bundle,
            digestCanonicalJson('some other envelope'),
            true,
          );
        },
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EXECUTED_VERIFICATION_FAILED' });

    let verifierError: unknown;
    try {
      await loadExecutedEvaluation({
        reference,
        resolver: ports.contentResolver,
        verifier: {
          verifierId: 'test.failing-executed-verifier/v1',
          async verify() {
            throw new Error('private signing-key path');
          },
        },
      });
    } catch (error) {
      verifierError = error;
    }

    expect(verifierError).toBeInstanceOf(ExecutedEvaluationStoreError);
    expect((verifierError as Error).message).not.toContain('private signing-key path');
  });

  it('rejects a tampered envelope even when storage and the verifier accept its new digest', async () => {
    const ports = inMemoryContentPorts();
    const executed = await executeEvaluation(evaluationInput(), {
      runId: 'staged-store-tampered',
    });
    const originalReference = await saveExecutedEvaluation({
      executed,
      store: ports.contentStore,
    });
    const original = ports.values.get(originalReference.digest)!;
    const envelope = structuredClone(original.value) as Record<string, JsonValue>;
    (envelope.bundle as Record<string, JsonValue>).executionInputDigest
      = digestCanonicalJson('forged execution input');
    const tamperedDigest = digestCanonicalJson(envelope);
    ports.values.set(tamperedDigest, { ...original, value: envelope });

    await expect(loadExecutedEvaluation({
      reference: { mediaType: EXECUTED_EVALUATION_MEDIA_TYPE, digest: tamperedDigest },
      resolver: ports.contentResolver,
      verifier: {
        verifierId: 'test.permissive-executed-verifier/v1',
        async verify({ reference: candidate }) {
          return executedVerificationFor(executed.bundle, candidate.digest, true);
        },
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EXECUTED_CONTENT_INVALID' });
  });

  it('binds one loaded envelope to the execution stage it was sealed for', async () => {
    const ports = inMemoryContentPorts();
    const executed = await executeEvaluation(evaluationInput(), {
      runId: 'staged-store-binding',
    });
    const reference = await saveExecutedEvaluation({
      executed,
      store: ports.contentStore,
    });
    const loaded = await reload(ports, reference, executed);
    const incompatible = evaluationInput();
    incompatible.variants[0].artifact = {
      ...incompatible.variants[0].artifact,
      content: 'A different prompt.',
    };

    await expect(scoreExecutedEvaluation(incompatible, loaded, {
      runId: 'staged-store-binding-scored',
    })).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_REUSE_INVALID',
      message: 'ExecutedEvaluation 与新声明的可复用阶段不一致。',
    });
  });

  it('requires one reference-captured execution output to stay resolvable', async () => {
    const ports = inMemoryContentPorts();
    const input = evaluationInput({
      evidence: { output: 'reference', trace: 'none' },
    }, {
      contentStore: ports.contentStore,
      contentResolver: ports.contentResolver,
    });
    const executed = await executeEvaluation(input, { runId: 'staged-store-closure' });
    const record = executed.bundle.records[0];
    const output = record.executionStatus === 'completed' ? record.output : undefined;
    expect(output?.contentKind).toBe('descriptor');
    if (output?.contentKind !== 'descriptor') return;
    const reference = await saveExecutedEvaluation({
      executed,
      store: ports.contentStore,
    });
    ports.values.delete(output.descriptor.digest);

    await expect(reload(ports, reference, executed)).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_EXECUTED_RESOLVE_FAILED',
    });
  });
});
