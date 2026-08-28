import { describe, expect, it } from 'vitest';
import {
  EvaluationDefinitionError,
  prepareEvaluationPlan,
} from '../../../src/evaluation-core/compiler/index.js';
import type { JsonValue } from '../../../src/evaluation-core/contracts/index.js';
import {
  testRuntime,
  validDefinition,
  validPolicy,
} from './fixtures.js';

function extension(data: JsonValue) {
  return {
    schemaUri: 'urn:example:schema:extension:v1',
    schemaDigest: `sha256:${'a'.repeat(64)}` as const,
    data,
  };
}

describe('prepareEvaluationPlan', () => {
  it('resolves actual runtime facts and produces a deterministic sealed plan', async () => {
    const definition = validDefinition();
    const policy = validPolicy();
    const runtime = testRuntime();
    const first = await prepareEvaluationPlan(definition, policy, runtime);
    const second = await prepareEvaluationPlan(
      structuredClone(definition),
      structuredClone(policy),
      testRuntime(),
    );

    expect(second).toEqual(first);
    expect(first.execution.runtimes).toHaveLength(2);
    expect(first.execution.runtimes[0].identity.implementationId).toBe('actual-executor/v1');
    expect(first.schemaIdentities.some(
      (identity) => identity.schemaUri === 'urn:example:schema:omk.invoke/v1:input:v1',
    )).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.execution.samples[0].input)).toBe(true);
    expect(() => {
      (first.execution.samples[0].input as { question: string }).question = 'mutated';
    }).toThrow();
  });

  it('takes an independent snapshot of inputs and resolver results', async () => {
    const definition = validDefinition();
    const policy = validPolicy();
    const runtime = testRuntime();
    const plan = await prepareEvaluationPlan(definition, policy, runtime);
    const originalDigest = plan.digests.runContractDigest;

    (definition.dataset.samples[0].expected as { answer: string }).answer = 'changed';
    policy.execution.maxConcurrency = 99;
    runtime.returnedIdentities[0].fingerprint = 'mutated-after-prepare';

    expect(plan.evaluation.samples[0].expected).toEqual({ answer: 'A' });
    expect(plan.measurementPolicy.execution.maxConcurrency).toBe(2);
    expect(plan.execution.runtimes[0].identity.fingerprint).toBe('executor-fingerprint-1');
    expect(plan.digests.runContractDigest).toBe(originalDigest);
  });

  it('keeps Gold, evaluation context, and annotations out of ExecutionPlan', async () => {
    const plan = await prepareEvaluationPlan(
      validDefinition(),
      validPolicy(),
      testRuntime(),
    );

    expect(plan.execution.samples[0]).toEqual({
      sampleId: 'sample-1',
      input: { question: 'Q', cohort: 'a' },
      executionContext: { locale: 'zh-CN' },
    });
    expect(plan.execution.samples[0]).not.toHaveProperty('expected');
    expect(plan.execution.samples[0]).not.toHaveProperty('evaluationContext');
    expect(plan.execution.samples[0]).not.toHaveProperty('annotations');
    expect(plan.evaluation.samples[0]).toMatchObject({
      expected: { answer: 'A' },
      evaluationContext: { rubric: 'correctness' },
    });
    expect(plan.evaluation.samples[0]).not.toHaveProperty('annotations');
  });

  it('routes validated extensions only to their declared impact stage', async () => {
    const definition = validDefinition();
    definition.extensions = {
      'urn:example:execution-extension': extension({ temperature: 0 }),
    };
    const policy = validPolicy();
    policy.extensions = {
      'urn:example:audit-extension': extension({ ticket: 'ABC-1' }),
      'urn:example:run-extension': extension({ governance: 'strict' }),
    };
    const runtime = testRuntime({
      extensionStages: {
        'urn:example:execution-extension': 'execution',
        'urn:example:audit-extension': 'audit',
        'urn:example:run-extension': 'run',
      },
    });

    const plan = await prepareEvaluationPlan(definition, policy, runtime);

    expect(plan.execution.extensions).toHaveProperty('urn:example:execution-extension');
    expect(plan.extensions).toHaveProperty('urn:example:run-extension');
    expect(plan.extensions).not.toHaveProperty('urn:example:audit-extension');
    expect(plan.measurementPolicy.extensions).toHaveProperty('urn:example:audit-extension');
    expect(runtime.calls.extension).toBe(3);
  });

  it('does not branch on descriptive targetKind', async () => {
    const definition = validDefinition();
    definition.targets[0].targetKind = 'future-target-kind';

    const plan = await prepareEvaluationPlan(definition, validPolicy(), testRuntime());

    expect(plan.execution.targets[0].targetKind).toBe('future-target-kind');
    expect(plan.execution.runtimes[0].identity.implementationId).toBe('actual-executor/v1');
  });

  it('selects invoke and session behavior through protocol manifests', async () => {
    const definition = validDefinition();
    definition.targets[0].protocolId = 'omk.session/v1';
    const plan = await prepareEvaluationPlan(
      definition,
      validPolicy(),
      testRuntime({ executorProtocols: ['omk.invoke/v1', 'omk.session/v1'] }),
    );

    expect(plan.execution.targets.map((target) => target.protocolId)).toEqual([
      'omk.session/v1',
      'omk.invoke/v1',
    ]);
  });

  it('normalizes set-like capability manifest ordering deterministically', async () => {
    const definition = validDefinition();
    const first = await prepareEvaluationPlan(
      definition,
      validPolicy(),
      testRuntime({ executorProtocols: ['omk.invoke/v1', 'omk.session/v1'] }),
    );
    const second = await prepareEvaluationPlan(
      definition,
      validPolicy(),
      testRuntime({ executorProtocols: ['omk.session/v1', 'omk.invoke/v1'] }),
    );

    expect(second).toEqual(first);
  });

  it('redacts resolver exceptions from the public error and cause chain', async () => {
    await expect(prepareEvaluationPlan(
      validDefinition(),
      validPolicy(),
      testRuntime({ throwExecutor: true }),
    )).rejects.toMatchObject({
      code: 'EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED',
      stage: 'infrastructure',
      preparationStage: 'runtime-resolution',
    });
    try {
      await prepareEvaluationPlan(
        validDefinition(),
        validPolicy(),
        testRuntime({ throwExecutor: true }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(EvaluationDefinitionError);
      expect(JSON.stringify(error)).not.toContain('secret provider response');
    }
  });
});
