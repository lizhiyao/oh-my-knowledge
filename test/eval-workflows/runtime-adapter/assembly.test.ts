import { describe, expect, it } from 'vitest';
import {
  createEvaluationSeriesDefinition,
  createEvaluationEngine,
  digestCanonicalJson,
  prepareEvaluationSeriesPlan,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../../../src/index.js';
import { RuntimeIdentitySchema } from '../../../src/evaluation-core/contracts/index.js';
import type {
  AnalysisDecisionPolicy,
  AnalysisMissingPolicy,
  AnalysisNodeImplementation,
} from '../../../src/evaluation-core/analysis/index.js';
import type {
  AnalysisRuntimeRequirement,
  RuntimeResolution,
} from '../../../src/evaluation-core/compiler/index.js';
import type { EvaluationEvaluator } from '../../../src/evaluation-core/evaluation/index.js';
import type { ExecutionExecutor } from '../../../src/evaluation-core/execution/index.js';
import type { SeriesAnalysisNodeRuntime } from '../../../src/evaluation-core/series/index.js';
import {
  assembleOmkRuntimeBindings,
  createBuiltinOmkAnalysisBindingFactories,
  type OmkRuntimeBindingFactories,
  type RuntimeBindingOf,
} from '../../../src/eval-workflows/runtime-adapter/index.js';
import { compileCliEvaluationInput } from '../../../src/eval-workflows/input-compilation/index.js';
import { testRuntime } from '../../evaluation-core/compiler/fixtures.js';
import { validResolvedCliInput } from '../input-compilation/fixtures.js';

type Mutable<Value> = Value extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
    : Value;

function clone<Value>(value: Value): Mutable<Value> {
  return structuredClone(value) as Mutable<Value>;
}

function runtimeAssemblyInput(): Mutable<ReturnType<typeof validResolvedCliInput>> {
  const input = clone(validResolvedCliInput());
  for (const target of input.targets) target.executor.implementationId = 'test.executor/v1';
  for (const template of input.evaluatorTemplates) {
    if (template.implementationId !== undefined) {
      template.implementationId = `test.evaluator.${template.evaluatorId}/v1`;
    }
  }
  for (const member of input.judges.members) {
    member.implementationId = `test.evaluator.${member.ensembleMemberId}/v1`;
  }
  for (const metric of input.metrics) metric.missingPolicyId = 'test.missing.exclude/v1';
  for (const node of input.analysisGraph.nodes) {
    node.implementationId = `test.analysis.${node.nodeId}/v1`;
  }
  input.experiment.sampling.estimatorId = 'test.analysis.sampling-estimator/v1';
  if (input.decisionPolicy !== undefined) {
    input.decisionPolicy.implementationId = 'test.decision/v1';
  }
  return input;
}

function bindingIdentity(
  implementationId: string,
  referenceId: string,
  base: RuntimeIdentity,
  capabilities: RuntimeIdentity['capabilities'] = base.capabilities,
): RuntimeIdentity {
  return RuntimeIdentitySchema.parse({
    ...structuredClone(base),
    implementationId,
    capabilities,
    fingerprint: digestCanonicalJson({
      base: base.fingerprint,
      capabilities,
      implementationId,
      referenceId,
    }),
    implementationManifest: {
      coverageKind: 'fingerprint-plus-facets',
      facets: [{ facetId: 'binding-reference', value: referenceId }],
    },
  });
}

function analysisRequirement(
  binding: RuntimeBindingOf<'analysis-node'>,
): AnalysisRuntimeRequirement {
  return Object.freeze({
    requirementKind: binding.requirementKind,
    referenceId: binding.referenceId,
    implementationId: binding.implementationId,
    ...(binding.versionConstraint === undefined ? {} : {
      versionConstraint: binding.versionConstraint,
    }),
    analysisNodeKind: binding.analysisNodeKind,
  });
}

function outputSchema(identity: RuntimeIdentity): SchemaIdentity {
  const capabilities = identity.capabilities as { outputSchema?: SchemaIdentity };
  if (capabilities.outputSchema === undefined) throw new Error('missing output schema');
  return capabilities.outputSchema;
}

function factoriesFor(
  compiled: ReturnType<typeof compileCliEvaluationInput>,
  calls: string[],
): OmkRuntimeBindingFactories {
  const preparation = testRuntime({
    evaluatorValueTypes: ['numeric', 'boolean', 'categorical', 'text', 'ranking'],
  });
  const executors = new Map<string, OmkRuntimeBindingFactories[
    'executorsByImplementationId'
  ] extends ReadonlyMap<string, infer Factory> ? Factory : never>();
  const evaluators = new Map<string, OmkRuntimeBindingFactories[
    'evaluatorsByImplementationId'
  ] extends ReadonlyMap<string, infer Factory> ? Factory : never>();
  const analysisNodes = new Map<string, OmkRuntimeBindingFactories[
    'analysisNodesByImplementationId'
  ] extends ReadonlyMap<string, infer Factory> ? Factory : never>();
  const missingPolicies = new Map<string, OmkRuntimeBindingFactories[
    'missingPoliciesByImplementationId'
  ] extends ReadonlyMap<string, infer Factory> ? Factory : never>();
  const decisionPolicies = new Map<string, OmkRuntimeBindingFactories[
    'decisionPoliciesByImplementationId'
  ] extends ReadonlyMap<string, infer Factory> ? Factory : never>();
  const seriesAnalysisNodes = new Map<string, OmkRuntimeBindingFactories[
    'seriesAnalysisNodesByImplementationId'
  ] extends ReadonlyMap<string, infer Factory> ? Factory : never>();

  for (const binding of compiled.runtimeBinding.bindings) {
    if (binding.runtimeKind === 'executor' && !executors.has(binding.implementationId)) {
      executors.set(binding.implementationId, async ({ binding: request }) => {
        calls.push(request.bindingId);
        const resolved = await preparation.resolveExecutor(Object.freeze({
          referenceId: request.targetId,
          executorId: request.implementationId,
          ...(request.versionConstraint === undefined ? {} : {
            versionConstraint: request.versionConstraint,
          }),
          protocolId: request.protocolId,
        })) as RuntimeResolution;
        const identity = bindingIdentity(
          request.implementationId,
          request.targetId,
          resolved.identity,
        );
        const port: ExecutionExecutor = {
          identity,
          async openRun() { throw new Error('test prepare must not open an Executor'); },
        };
        return { port, satisfiesVersionConstraint: true };
      });
    } else if (binding.runtimeKind === 'evaluator'
        && !evaluators.has(binding.implementationId)) {
      evaluators.set(binding.implementationId, async ({ binding: request }) => {
        calls.push(request.bindingId);
        const resolved = await preparation.resolveEvaluator(Object.freeze({
          referenceId: request.evaluatorId,
          implementationId: request.implementationId,
          ...(request.versionConstraint === undefined ? {} : {
            versionConstraint: request.versionConstraint,
          }),
        })) as RuntimeResolution;
        const identity = bindingIdentity(
          request.implementationId,
          request.evaluatorId,
          resolved.identity,
        );
        const port: EvaluationEvaluator = {
          identity,
          async openRun() { throw new Error('test prepare must not open an Evaluator'); },
        };
        return { port, satisfiesVersionConstraint: true };
      });
    } else if (binding.runtimeKind === 'analysis-node'
        && !analysisNodes.has(binding.implementationId)) {
      analysisNodes.set(binding.implementationId, async ({ binding: request }) => {
        calls.push(request.bindingId);
        const resolved = await preparation.resolveAnalysis(
          analysisRequirement(request),
        ) as RuntimeResolution;
        const baseCapabilities = resolved.identity.capabilities as unknown as {
          outputSchema: SchemaIdentity;
          parameterSchema: SchemaIdentity;
          schemas: SchemaIdentity[];
        };
        const capabilities: JsonValue = request.requirementKind === 'sampling-estimator'
          ? {
              ...baseCapabilities,
              capabilityKind: 'analysis-node' as const,
              analysisNodeKinds: ['estimator'],
              inputDomains: [],
              inputCardinalities: {
                metricObservations: { min: 0, max: 0 },
                analysisResults: { min: 0, max: 0 },
                comparisons: { min: 0, max: 0 },
              },
              sampling: {
                experimentalUnits: [compiled.definition.experiment.sampling.experimentalUnit],
                repeatedMeasures: [compiled.definition.experiment.sampling.repeatedMeasures],
                resamplingUnits: [compiled.definition.experiment.sampling.resamplingUnit],
              },
            }
          : {
              ...baseCapabilities,
              capabilityKind: 'analysis-node' as const,
              analysisNodeKinds: [request.analysisNodeKind],
              inputDomains: [
                {
                  inputKind: 'metric-observations' as const,
                  valueTypes: ['numeric', 'boolean', 'categorical', 'text', 'ranking'],
                  missingPolicyIds: ['test.missing.exclude/v1'],
                },
                { inputKind: 'comparison' as const },
                {
                  inputKind: 'analysis-result' as const,
                  schemaUris: [baseCapabilities.outputSchema.schemaUri],
                },
              ],
              inputCardinalities: {
                metricObservations: { min: 0, max: 100 },
                analysisResults: { min: 0, max: 100 },
                comparisons: { min: 0, max: 100 },
              },
            };
        const identity = bindingIdentity(
          request.implementationId,
          request.referenceId,
          resolved.identity,
          capabilities,
        );
        const port: AnalysisNodeImplementation = {
          identity,
          outputSchema: outputSchema(identity),
          async openRun() { throw new Error('test prepare must not open Analysis'); },
        };
        return { port, satisfiesVersionConstraint: true };
      });
    } else if (binding.runtimeKind === 'missing-policy'
        && !missingPolicies.has(binding.implementationId)) {
      missingPolicies.set(binding.implementationId, async ({ binding: request }) => {
        calls.push(request.bindingId);
        const resolved = await preparation.resolveAnalysis(Object.freeze({
          requirementKind: 'missing-policy',
          referenceId: request.policyId,
          implementationId: request.implementationId,
        })) as RuntimeResolution;
        const port: AnalysisMissingPolicy = {
          identity: bindingIdentity(
            request.implementationId,
            request.policyId,
            resolved.identity,
          ),
          decide: () => 'exclude',
        };
        return { port, satisfiesVersionConstraint: true };
      });
    } else if (binding.runtimeKind === 'decision-policy'
        && !decisionPolicies.has(binding.implementationId)) {
      decisionPolicies.set(binding.implementationId, async ({ binding: request }) => {
        calls.push(request.bindingId);
        const resolved = await preparation.resolveAnalysis(Object.freeze({
          requirementKind: 'decision-policy',
          referenceId: request.decisionPolicyId,
          implementationId: request.implementationId,
          ...(request.versionConstraint === undefined ? {} : {
            versionConstraint: request.versionConstraint,
          }),
        })) as RuntimeResolution;
        const port: AnalysisDecisionPolicy = {
          identity: bindingIdentity(
            request.implementationId,
            request.decisionPolicyId,
            resolved.identity,
          ),
          async decide() {
            return { decisionStatus: 'not-decided', reasonCodes: ['test-only'] };
          },
        };
        return { port, satisfiesVersionConstraint: true };
      });
    } else if (binding.runtimeKind === 'series-analysis-node'
        && !seriesAnalysisNodes.has(binding.implementationId)) {
      seriesAnalysisNodes.set(binding.implementationId, ({ binding: request }) => {
        calls.push(request.bindingId);
        const schema: SchemaIdentity = {
          schemaVersion: 'test.series-output/v1',
          schemaUri: 'urn:test:series-output:v1',
          schemaDigest: digestCanonicalJson({ schema: 'series-output' }),
        };
        const identity = RuntimeIdentitySchema.parse({
          implementationId: request.implementationId,
          fingerprint: digestCanonicalJson({ implementationId: request.implementationId }),
          fingerprintBasis: 'content-derived',
          assuranceLevel: 'verified',
          capabilities: { experimentalUnit: 'run' },
          implementationManifest: { coverageKind: 'fingerprint-complete' },
        });
        const port: SeriesAnalysisNodeRuntime = {
          identity,
          outputSchema: schema,
          async analyze() { return { analysisStatus: 'inconclusive', reasonCodes: ['test-only'] }; },
        };
        return { port, satisfiesVersionConstraint: true };
      });
    }
  }
  return {
    executorsByImplementationId: executors,
    evaluatorsByImplementationId: evaluators,
    analysisNodesByImplementationId: analysisNodes,
    missingPoliciesByImplementationId: missingPolicies,
    decisionPoliciesByImplementationId: decisionPolicies,
    seriesAnalysisNodesByImplementationId: seriesAnalysisNodes,
    seriesDecisionPoliciesByImplementationId: new Map(),
  };
}

const clock = {
  monotonicNow: () => 0,
  timestamp: () => '2026-08-30T00:00:00.000Z',
  async sleep(_delayMs: number, signal: AbortSignal) {
    if (signal.aborted) throw new Error('aborted');
  },
};

describe('OMK Evaluation Runtime binding assembly', () => {
  it('assembles exact reference bindings and passes a real Core prepare', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const calls: string[] = [];
    const factories = factoriesFor(compiled, calls);

    const assembly = await assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: compiled.runtimeBinding,
      factories,
    });
    const preparation = testRuntime();
    const prepared = await createEvaluationEngine({
      bindings: assembly.evaluation.bindings,
      clock,
      schemaValidators: preparation.schemaValidators,
    }).prepare(compiled.definition, compiled.policy);

    expect(prepared.plan.execution.targets).toEqual(compiled.definition.targets);
    expect(assembly.evaluation.entries).toHaveLength(compiled.runtimeBinding.bindings.length);
    expect(calls).toHaveLength(compiled.runtimeBinding.bindings.length);
    expect(new Set(assembly.evaluation.entries.map((entry) => entry.sessionIsolationKey)).size)
      .toBe(assembly.evaluation.entries.length);
    for (const entry of assembly.evaluation.entries) {
      expect(Object.isFrozen(entry.binding)).toBe(true);
      expect(Object.isFrozen(entry.resolution.identity)).toBe(true);
      expect(entry.port.identity).toBe(entry.resolution.identity);
    }
    const treatmentEntry = assembly.evaluation.entries.find((entry) => (
      entry.runtimeKind === 'executor' && entry.binding.targetId === 'treatment'
    ));
    expect(treatmentEntry?.resourceLeaseRequirements.map((requirement) => (
      `${requirement.resourceRole}:${requirement.leaseMode}`
    ))).toEqual([
      'artifact:immutable-snapshot',
      'mcp-config:immutable-snapshot',
      'mock-payload:immutable-snapshot',
      'workspace:copy-on-write-overlay',
    ]);
    expect(assembly.evaluation.entries.some((entry) => (
      entry.runtimeKind === 'missing-policy'
      && entry.binding.policyId === 'test.missing.exclude/v1'
    ))).toBe(true);
  });

  it('creates distinct binding entries for targets sharing one implementation', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const assembly = await assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: compiled.runtimeBinding,
      factories: factoriesFor(compiled, []),
    });
    const executors = assembly.evaluation.entries.filter((entry) => (
      entry.runtimeKind === 'executor'
    ));

    expect(executors).toHaveLength(2);
    expect(executors[0].binding.implementationId).toBe(executors[1].binding.implementationId);
    expect(executors[0].binding.targetId).not.toBe(executors[1].binding.targetId);
    expect(executors[0].resolution.identity.fingerprint)
      .not.toBe(executors[1].resolution.identity.fingerprint);
    expect(executors[0].port).not.toBe(executors[1].port);
  });

  it.each(['missing', 'mismatched', 'resource-mismatched'] as const)(
    'fails before invoking factories for a %s Definition binding',
    async (scenario) => {
      const input = runtimeAssemblyInput();
      delete input.orchestration.independentSeries;
      const compiled = compileCliEvaluationInput(input);
      const request = clone(compiled.runtimeBinding);
      if (scenario === 'missing') request.bindings.pop();
      else if (scenario === 'mismatched') {
        const executor = request.bindings.find((binding) => binding.runtimeKind === 'executor');
        if (executor?.runtimeKind !== 'executor') throw new Error('missing fixture binding');
        executor.protocolId = executor.protocolId === 'omk.invoke/v1'
          ? 'omk.session/v1'
          : 'omk.invoke/v1';
      } else {
        const executor = request.bindings.find((binding) => binding.runtimeKind === 'executor');
        if (executor?.runtimeKind !== 'executor') throw new Error('missing fixture binding');
        executor.resourceLeaseRequirements.pop();
      }
      const calls: string[] = [];

      await expect(assembleOmkRuntimeBindings({
        definition: compiled.definition,
        runtimeBinding: request,
        factories: factoriesFor(compiled, calls),
      })).rejects.toMatchObject({
        code: scenario === 'missing'
          ? 'OMK_RUNTIME_BINDING_COVERAGE_MISMATCH'
          : 'OMK_RUNTIME_BINDING_DEFINITION_MISMATCH',
      });
      expect(calls).toEqual([]);
    },
  );

  it('rejects an unknown binding discriminator before invoking factories', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const request = clone(compiled.runtimeBinding);
    (request.bindings[0] as { runtimeKind: string }).runtimeKind = 'unknown-runtime';
    const calls: string[] = [];

    await expect(assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: request as typeof compiled.runtimeBinding,
      factories: factoriesFor(compiled, calls),
    })).rejects.toMatchObject({ code: 'OMK_RUNTIME_BINDING_REQUEST_INVALID' });
    expect(calls).toEqual([]);
  });

  it('rejects the incomplete v1 binding request without compatibility inference', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const request = clone(compiled.runtimeBinding) as { schemaVersion: string };
    request.schemaVersion = 'omk.runtime-binding-request/v1';
    const calls: string[] = [];

    await expect(assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: request as typeof compiled.runtimeBinding,
      factories: factoriesFor(compiled, calls),
    })).rejects.toMatchObject({ code: 'OMK_RUNTIME_BINDING_REQUEST_INVALID' });
    expect(calls).toEqual([]);
  });

  it('rejects a factory whose actual port identity names another implementation', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const factories = factoriesFor(compiled, []);
    const implementationId = compiled.runtimeBinding.bindings.find((binding) => (
      binding.runtimeKind === 'executor'
    ))?.implementationId;
    if (implementationId === undefined) throw new Error('missing fixture implementation');
    const wrongIdentity = RuntimeIdentitySchema.parse({
      implementationId: 'test.wrong-implementation/v1',
      fingerprint: 'wrong',
      fingerprintBasis: 'opaque',
      assuranceLevel: 'unknown',
      capabilities: {},
      implementationManifest: { coverageKind: 'fingerprint-complete' },
    });
    const port: ExecutionExecutor = {
      identity: wrongIdentity,
      async openRun() { throw new Error('must not run'); },
    };
    const executors = new Map(factories.executorsByImplementationId);
    executors.set(implementationId, () => ({ port, satisfiesVersionConstraint: true }));

    await expect(assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: compiled.runtimeBinding,
      factories: { ...factories, executorsByImplementationId: executors },
    })).rejects.toMatchObject({ code: 'OMK_RUNTIME_BINDING_PORT_INVALID' });
  });

  it('rejects an Analysis port whose output schema differs from its identity capability', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const factories = factoriesFor(compiled, []);
    const binding = compiled.runtimeBinding.bindings.find((candidate) => (
      candidate.runtimeKind === 'analysis-node'
      && candidate.requirementKind === 'analysis-node'
    ));
    if (binding?.runtimeKind !== 'analysis-node') throw new Error('missing Analysis binding');
    const originalFactory = factories.analysisNodesByImplementationId
      .get(binding.implementationId);
    if (originalFactory === undefined) throw new Error('missing Analysis factory');
    const analysisNodes = new Map(factories.analysisNodesByImplementationId);
    analysisNodes.set(binding.implementationId, async (context) => {
      const result = await originalFactory(context);
      return {
        ...result,
        port: {
          ...result.port,
          outputSchema: {
            schemaVersion: 'test.mismatched/v1',
            schemaUri: 'urn:test:mismatched:v1',
            schemaDigest: digestCanonicalJson({ schema: 'mismatched' }),
          },
        },
      };
    });

    await expect(assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: compiled.runtimeBinding,
      factories: { ...factories, analysisNodesByImplementationId: analysisNodes },
    })).rejects.toMatchObject({ code: 'OMK_RUNTIME_BINDING_PORT_INVALID' });
  });

  it('checks complete factory coverage before invoking any factory', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const calls: string[] = [];
    const factories = factoriesFor(compiled, calls);
    const executors = new Map(factories.executorsByImplementationId);
    executors.clear();

    await expect(assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: compiled.runtimeBinding,
      factories: { ...factories, executorsByImplementationId: executors },
    })).rejects.toMatchObject({ code: 'OMK_RUNTIME_BINDING_FACTORY_MISSING' });
    expect(calls).toEqual([]);
  });

  it('keeps factory failures distinct from invalid returned ports', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const factories = factoriesFor(compiled, []);
    const first = [...compiled.runtimeBinding.bindings]
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId))[0];
    if (first.runtimeKind !== 'analysis-node') throw new Error('unexpected fixture ordering');
    const analysisNodes = new Map(factories.analysisNodesByImplementationId);
    analysisNodes.set(first.implementationId, () => { throw new Error('factory failed'); });

    await expect(assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: compiled.runtimeBinding,
      factories: { ...factories, analysisNodesByImplementationId: analysisNodes },
    })).rejects.toMatchObject({
      code: 'OMK_RUNTIME_BINDING_FACTORY_FAILED',
      bindingId: first.bindingId,
    });
  });

  it('captures ports independently from later factory registry mutation', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const factories = factoriesFor(compiled, []);
    const assembly = await assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: compiled.runtimeBinding,
      factories,
    });
    const targetId = compiled.definition.targets[0].targetId;
    const before = await assembly.evaluation.bindings.resolveExecutor({
      referenceId: targetId,
      executorId: compiled.definition.targets[0].executorId,
      ...(compiled.definition.targets[0].versionConstraint === undefined ? {} : {
        versionConstraint: compiled.definition.targets[0].versionConstraint,
      }),
      protocolId: compiled.definition.targets[0].protocolId,
    });
    (factories.executorsByImplementationId as Map<string, unknown>).clear();
    const after = await assembly.evaluation.bindings.resolveExecutor({
      referenceId: targetId,
      executorId: compiled.definition.targets[0].executorId,
      ...(compiled.definition.targets[0].versionConstraint === undefined ? {} : {
        versionConstraint: compiled.definition.targets[0].versionConstraint,
      }),
      protocolId: compiled.definition.targets[0].protocolId,
    });

    expect(after.port).toBe(before.port);
    expect(after.resolution).toBe(before.resolution);
  });

  it('preserves version resolution for Core to reject during preparation', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const factories = factoriesFor(compiled, []);
    const implementationId = compiled.definition.targets[0].executorId;
    const originalFactory = factories.executorsByImplementationId.get(implementationId);
    if (originalFactory === undefined) throw new Error('missing executor factory');
    const executors = new Map(factories.executorsByImplementationId);
    executors.set(implementationId, async (context) => ({
      ...await originalFactory(context),
      satisfiesVersionConstraint: false,
    }));
    const assembly = await assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: compiled.runtimeBinding,
      factories: { ...factories, executorsByImplementationId: executors },
    });
    const preparation = testRuntime();

    await expect(createEvaluationEngine({
      bindings: assembly.evaluation.bindings,
      clock,
      schemaValidators: preparation.schemaValidators,
    }).prepare(compiled.definition, compiled.policy)).rejects.toMatchObject({
      code: 'EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED',
      preparationStage: 'runtime-resolution',
    });
  });

  it('captures an immutable request snapshot before factories can observe later mutation', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const request = clone(compiled.runtimeBinding);
    const assembly = await assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding: request,
      factories: factoriesFor(compiled, []),
    });
    const mutableExecutor = request.bindings.find((binding) => binding.runtimeKind === 'executor');
    if (mutableExecutor?.runtimeKind !== 'executor') throw new Error('missing executor binding');
    mutableExecutor.protocolId = 'omk.session/v1';
    const captured = assembly.evaluation.entries.find((entry) => (
      entry.runtimeKind === 'executor' && entry.binding.bindingId === mutableExecutor.bindingId
    ));

    expect(captured?.runtimeKind).toBe('executor');
    if (captured?.runtimeKind !== 'executor') throw new Error('missing captured binding');
    expect(captured.binding.protocolId).toBe('omk.invoke/v1');
    expect(captured.binding).not.toBe(mutableExecutor);
  });

  it('assembles Series ports outside EvaluationEngineRuntime', async () => {
    const compiled = compileCliEvaluationInput(runtimeAssemblyInput());
    const series = compiled.orchestration.independentSeries;
    if (series === undefined) throw new Error('missing fixture Series');
    const { seriesDesignDigest: _seriesDesignDigest, ...seriesInput } = clone(series.definition);
    expect(_seriesDesignDigest).toBe(series.definition.seriesDesignDigest);
    seriesInput.analysisGraph.nodes[0].implementationId = 'test.series.analysis/v1';
    const seriesDefinition = createEvaluationSeriesDefinition(seriesInput);
    const runtimeBinding = clone(compiled.runtimeBinding);
    const seriesBinding = runtimeBinding.bindings.find((binding) => (
      binding.runtimeKind === 'series-analysis-node'
    ));
    if (seriesBinding?.runtimeKind !== 'series-analysis-node') {
      throw new Error('missing Series binding');
    }
    const originalImplementationId = seriesBinding.implementationId;
    seriesBinding.implementationId = 'test.series.analysis/v1';
    const factories = factoriesFor(compiled, []);
    const seriesFactory = factories.seriesAnalysisNodesByImplementationId
      .get(originalImplementationId);
    if (seriesFactory === undefined) throw new Error('missing Series factory');
    const seriesFactories = new Map(factories.seriesAnalysisNodesByImplementationId);
    seriesFactories.delete(originalImplementationId);
    seriesFactories.set(seriesBinding.implementationId, seriesFactory);
    const assembly = await assembleOmkRuntimeBindings({
      definition: compiled.definition,
      runtimeBinding,
      seriesDefinition,
      factories: { ...factories, seriesAnalysisNodesByImplementationId: seriesFactories },
    });
    if (assembly.series === undefined) throw new Error('missing Series assembly');

    const plan = prepareEvaluationSeriesPlan(seriesDefinition, assembly.series.runtimes);
    expect(plan.definition.seriesDesignDigest).toBe(seriesDefinition.seriesDesignDigest);
    expect(assembly.series.ports.analysisNodesByNodeId.has('run-variance')).toBe(true);
    expect((assembly.series.ports.analysisNodesByNodeId as unknown as { set?: unknown }).set)
      .toBeUndefined();
    expect(assembly.evaluation.entries.some((entry) => (
      entry.runtimeKind === ('series-analysis-node' as string)
    ))).toBe(false);
  });

  it('reuses Core built-in analysis ports without host algorithm copies', () => {
    const builtins = createBuiltinOmkAnalysisBindingFactories();
    expect(builtins.analysisNodesByImplementationId.has('bootstrap.mean-percentile/v1')).toBe(true);
    expect(builtins.missingPoliciesByImplementationId.has('exclude/v1')).toBe(true);
    expect(builtins.decisionPoliciesByImplementationId.has('progress/v1')).toBe(true);
  });
});
