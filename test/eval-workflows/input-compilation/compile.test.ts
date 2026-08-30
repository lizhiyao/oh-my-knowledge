import { describe, expect, it } from 'vitest';
import {
  EvaluationDefinitionSchema,
  MeasurementPolicySchema,
  canonicalizeJson,
  digestCanonicalJson,
  projectAnalysisInputs,
  projectEvaluationInputs,
  projectExecutionInputs,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  CliEvaluationInputError,
  compileCliEvaluationInput,
} from '../../../src/eval-workflows/input-compilation/index.js';
import { validResolvedCliInput } from './fixtures.js';

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function deepClone<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe('compileCliEvaluationInput', () => {
  it('produces schema-valid, immutable and independently owned contracts', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());

    expect(EvaluationDefinitionSchema.parse(result.definition)).toEqual(result.definition);
    expect(MeasurementPolicySchema.parse(result.policy)).toEqual(result.policy);
    expectDeepFrozen(result);
    expect(result.canonicalDigests).toEqual({
      definition: digestCanonicalJson(result.definition),
      policy: digestCanonicalJson(result.policy),
    });
    expect(result.definition.targets.map((target) => target.targetId)).toEqual(['control', 'treatment']);
    expect(result.definition.targets[0].config).toMatchObject({
      behavior: { allowedSkills: [] },
      runtime: { model: 'gpt-example', effort: 'low' },
    });
    expect(result.policy.budget).toMatchObject({
      run: { maxInvocations: 100, maxProviderCost: { amount: 10, currency: 'USD' } },
      stages: {
        execution: { maxInvocations: 40 },
        evaluation: { maxInvocations: 60 },
      },
      coordinate: {
        maxProviderCost: { amount: 1, currency: 'USD' },
        maxActiveDurationMs: 30_000,
      },
    });
    expect(result.policy.retry.maxAttempts).toBe(3);
    expect(result.policy.cache).toEqual({
      executionMode: 'transparent-deterministic',
      evaluationMode: 'reuse',
    });
  });

  it('keeps expected, evaluation context and analysis-only membership out of target execution', () => {
    const { definition } = compileCliEvaluationInput(validResolvedCliInput());
    const execution = projectExecutionInputs(definition.dataset);
    const evaluation = projectEvaluationInputs(definition.dataset);
    const analysis = projectAnalysisInputs(definition.dataset);

    expect(canonicalizeJson(execution)).not.toContain('expected');
    expect(canonicalizeJson(execution)).not.toContain('evaluationContext');
    expect(canonicalizeJson(execution)).not.toContain('memberships');
    expect(canonicalizeJson(evaluation)).toContain('expected');
    expect(canonicalizeJson(evaluation)).toContain('evaluationContext');
    expect(canonicalizeJson(evaluation)).not.toContain('memberships');
    expect(canonicalizeJson(analysis)).toContain('memberships');
    expect(canonicalizeJson(analysis)).not.toContain('expected');
  });

  it('expands judge ensemble and replicates into explicit Core measurement identities', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());
    const judges = result.definition.evaluators.filter((evaluator) => evaluator.evaluatorKind === 'llm-rubric');
    expect(judges).toHaveLength(4);
    expect(judges.map((evaluator) => evaluator.measurement)).toEqual([
      {
        instrumentId: 'rubric-correctness-v1', ensembleMemberId: 'judge-a',
        replicateGroupId: 'rubric-primary', replicateIndex: 0,
      },
      {
        instrumentId: 'rubric-correctness-v1', ensembleMemberId: 'judge-a',
        replicateGroupId: 'rubric-primary', replicateIndex: 1,
      },
      {
        instrumentId: 'rubric-correctness-v1', ensembleMemberId: 'judge-b',
        replicateGroupId: 'rubric-primary', replicateIndex: 0,
      },
      {
        instrumentId: 'rubric-correctness-v1', ensembleMemberId: 'judge-b',
        replicateGroupId: 'rubric-primary', replicateIndex: 1,
      },
    ]);
    const judgeBindings = result.runtimeBinding.bindings.filter((binding) => (
      binding.runtimeKind === 'evaluator'
      && binding.implementationId.includes('judge-adapter')
    ));
    expect(judgeBindings).toHaveLength(4);
  });

  it('does not resolve or bind unused judges when judging is disabled', () => {
    const input = deepClone(validResolvedCliInput());
    input.judges.enabled = false;
    input.judges.members = [];
    const result = compileCliEvaluationInput(input);

    expect(result.definition.evaluators.map((evaluator) => evaluator.evaluatorKind)).toEqual(['assertion']);
    expect(result.runtimeBinding.bindings.some((binding) => (
      binding.runtimeKind === 'evaluator' && binding.implementationId.includes('judge')
    ))).toBe(false);
  });

  it('compiles independent repeats as an explicit Evaluation Series design', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());
    const series = result.orchestration.independentSeries;
    expect(series?.definition.experimentalUnit).toBe('run');
    expect(series?.definition.members).toHaveLength(3);
    expect(series?.memberships.map((membership) => membership.replicateIndex)).toEqual([0, 1, 2]);
    expect(series?.memberships.every((membership) => (
      membership.seriesDesignDigest === series.definition.seriesDesignDigest
    ))).toBe(true);
    expect(result.definition.experiment.trials).toBe(1);
    expect(result.policy.retry.maxAttempts).toBe(3);
  });

  it('keeps holdout, bootstrap, composite and gate semantics in explicit Core fields', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());
    expect(result.definition.dataset.analysisCohorts?.map((cohort) => cohort.cohortId))
      .toEqual(['holdout', 'train']);
    expect(result.definition.analysisGraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'bootstrap-difference',
        cohortFilter: { includeCohortIds: ['holdout'] },
        parameters: { resamples: 1000, alpha: 0.05 },
      }),
      expect.objectContaining({
        nodeId: 'composite-score',
        parameters: { weights: { assertion: 0.5, rubric: 0.5 } },
      }),
    ]));
    expect(result.definition.decisionPolicy).toMatchObject({
      decisionPolicyId: 'release-gate',
      parameters: { threshold: 3.5, trivialDifference: 0.1 },
    });
  });

  it('treats report-only as presentation and preserves the Core decision', () => {
    const input = deepClone(validResolvedCliInput());
    input.presentation.exitMode = 'report-only';
    const result = compileCliEvaluationInput(input);

    expect(result.presentation.exitMode).toBe('report-only');
    expect(result.definition.decisionPolicy?.decisionPolicyId).toBe('release-gate');
  });

  it('makes CLI/YAML source, property order, locator and lineage irrelevant to measurement digests', () => {
    const left = validResolvedCliInput();
    const right = deepClone(left);
    right.hostResources.resources.reverse();
    for (const resource of right.hostResources.resources) {
      resource.locator = `/other-machine/${resource.descriptor.resourceId}`;
      resource.lineage = { sourcePath: `moved/${resource.descriptor.resourceId}`, commit: 'different' };
    }
    right.targets.reverse();
    right.dataset.samples.reverse();
    right.judges.members.reverse();
    right.staticRunMetadata = { annotations: { source: 'eval.yaml' } };

    const leftResult = compileCliEvaluationInput(left);
    const rightResult = compileCliEvaluationInput(right);
    expect(rightResult.canonicalDigests).toEqual(leftResult.canonicalDigests);
    expect(rightResult.hostResources).not.toEqual(leftResult.hostResources);
  });

  it('changes behavior identity when injected artifact bytes change', () => {
    const left = validResolvedCliInput();
    const right = deepClone(left);
    const target = right.targets.find((candidate) => candidate.targetId === 'treatment');
    const resource = right.hostResources.resources.find((candidate) => (
      candidate.descriptor.resourceId === 'artifact-treatment'
    ));
    const changedDigest = digestCanonicalJson({ body: '# Skill\nChanged behavior.' });
    if (target === undefined || resource === undefined) throw new Error('fixture is incomplete');
    target.behavior.artifact.digest = changedDigest;
    resource.descriptor.digest = changedDigest;
    resource.verification.verifiedDigest = changedDigest;

    expect(compileCliEvaluationInput(right).canonicalDigests.definition)
      .not.toBe(compileCliEvaluationInput(left).canonicalDigests.definition);
  });

  it('keeps locators, presentation and orchestration fields out of Core canonical JSON', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());
    const core = canonicalizeJson({ definition: result.definition, policy: result.policy });
    expect(core).not.toContain('/repo/');
    expect(core).not.toContain('resumeSourceLocator');
    expect(core).not.toContain('outputDirectoryLocator');
    expect(core).not.toContain('report-only');
    expect(core).not.toContain('sourcePath');
    expect(core).not.toContain('RunConfig');
    expect(core).not.toContain('VariantSpec');
    expect(canonicalizeJson(result.runOptions)).not.toContain('runId');
    expect(canonicalizeJson(result.runOptions)).not.toContain('AbortSignal');
    expect(canonicalizeJson(result.runOptions)).not.toContain('EventWriter');
  });

  it('fails with a stable host error when a resource binding is dishonest', () => {
    const input = deepClone(validResolvedCliInput());
    input.hostResources.resources[0].verification.verifiedDigest = digestCanonicalJson('different');

    expect(() => compileCliEvaluationInput(input)).toThrowError(CliEvaluationInputError);
    try {
      compileCliEvaluationInput(input);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CLI_INPUT_RESOURCE_DIGEST_MISMATCH',
        fieldPath: expect.stringContaining('verification'),
      });
      expect((error as Error).message).toContain('验证摘要');
    }
  });

  it('derives Runtime bindings from Definition requirements without override fields', () => {
    const result = compileCliEvaluationInput(validResolvedCliInput());
    for (const target of result.definition.targets) {
      const binding = result.runtimeBinding.bindings.find((candidate) => (
        candidate.runtimeKind === 'executor' && candidate.targetId === target.targetId
      ));
      expect(binding).toMatchObject({
        runtimeKind: 'executor',
        targetId: target.targetId,
        implementationId: target.executorId,
        protocolId: target.protocolId,
        behaviorConfigDigest: digestCanonicalJson(target.config ?? null),
      });
      expect(binding).not.toHaveProperty('model');
      expect(binding).not.toHaveProperty('config');
      if (binding?.runtimeKind === 'executor') {
        expect(binding.qualification).toMatchObject({
          model: 'gpt-example',
          effort: 'low',
          workspace: 'required',
          mcp: 'required',
          mockInterception: 'required',
          toolPolicy: 'allow-list',
          resourceIntegrity: 'digest-before-use',
        });
      }
    }
    const treatmentBinding = result.runtimeBinding.bindings.find((binding) => (
      binding.runtimeKind === 'executor' && binding.targetId === 'treatment'
    ));
    expect(treatmentBinding).toMatchObject({
      qualification: { sandboxId: 'omk.local-sandbox/v1' },
    });
    const judgeBinding = result.runtimeBinding.bindings.find((binding) => (
      binding.runtimeKind === 'evaluator' && binding.implementationId === 'anthropic-judge-adapter/v1'
    ));
    expect(judgeBinding).toMatchObject({
      qualification: {
        executorId: 'anthropic-api',
        model: 'judge-a',
        promptVariant: 'rubric-length-debias-on/v1',
        resourceIntegrity: 'digest-before-use',
      },
    });
    const bindingJson = canonicalizeJson(result.runtimeBinding);
    expect(bindingJson).not.toContain('capabilities');
    expect(bindingJson).not.toContain('fingerprint');
    expect(bindingJson).not.toContain('assuranceLevel');
  });

  it('rejects inline secret evaluator or target configuration', () => {
    const input = deepClone(validResolvedCliInput());
    const target = input.targets.find((candidate) => candidate.targetId === 'treatment');
    if (target === undefined) throw new Error('fixture is incomplete');
    target.behavior.config = {
      classification: 'public',
      value: { token: 'secret' },
    };
    (target.behavior.config as { classification: string }).classification = 'secret';

    expect(() => compileCliEvaluationInput(input)).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_RESTRICTED_INLINE_CONTENT',
    }));
  });

  it('rejects accessor-backed input rather than executing effectful getters', () => {
    const input = deepClone(validResolvedCliInput());
    let getterCalls = 0;
    Object.defineProperty(input.presentation, 'unexpected', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'effect';
      },
    });

    expect(() => compileCliEvaluationInput(input)).toThrowError(expect.objectContaining({
      code: 'CLI_INPUT_INVALID',
    }));
    expect(getterCalls).toBe(0);
  });
});
