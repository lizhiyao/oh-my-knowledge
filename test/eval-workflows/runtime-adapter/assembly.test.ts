import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEvaluationSeriesDefinition,
  createEvaluationEngine,
  digestCanonicalJson,
  prepareEvaluationSeriesPlan,
  schemaIdentityKey,
  type CoreSchemaValidator,
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
  createOmkEvaluationRuntime,
  resourceLeaseRequestsFromBindingEntries,
  type OmkBindingResourceLease,
  type OmkBindingResourceLeaseRequest,
  type OmkEvaluationRuntimeSupportPorts,
  type OmkRunResourceLeases,
  type OmkRuntimeBindingFactories,
  type RuntimeBindingOf,
} from '../../../src/eval-workflows/runtime-adapter/index.js';
import {
  compileCliEvaluationInput,
  type ResolvedHostResources,
} from '../../../src/eval-workflows/input-compilation/index.js';
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

function runnableFactoriesFor(
  compiled: ReturnType<typeof compileCliEvaluationInput>,
  lifecycle: string[],
  executeGate?: Promise<void>,
): OmkRuntimeBindingFactories {
  const base = factoriesFor(compiled, []);
  const executors = new Map(base.executorsByImplementationId);
  for (const [implementationId, factory] of executors) {
    executors.set(implementationId, async (context) => {
      const resolved = await factory(context);
      return {
        ...resolved,
        port: {
          identity: resolved.port.identity,
          async openRun(runContext) {
            const lease = context.resourceLeases.forRun(runContext.runId);
            lifecycle.push(`executor.open:${runContext.runId}:${lease.bindingId}`);
            return {
              async openTrial() {
                return {
                  async execute() {
                    if (executeGate !== undefined) await executeGate;
                    return {
                      output: {
                        value: { answer: 'A' },
                        classification: 'public' as const,
                      },
                      trace: {
                        value: { source: 'test-runtime' },
                        classification: 'public' as const,
                      },
                    };
                  },
                  dispose() { lifecycle.push(`executor.trial.dispose:${runContext.runId}`); },
                };
              },
              dispose() { lifecycle.push(`executor.run.dispose:${runContext.runId}`); },
            };
          },
        },
      };
    });
  }
  const evaluators = new Map(base.evaluatorsByImplementationId);
  for (const [implementationId, factory] of evaluators) {
    evaluators.set(implementationId, async (context) => {
      const resolved = await factory(context);
      return {
        ...resolved,
        port: {
          identity: resolved.port.identity,
          async openRun(runContext) {
            const lease = context.resourceLeases.forRun(runContext.runId);
            lifecycle.push(`evaluator.open:${runContext.runId}:${lease.bindingId}`);
            return {
              async openRecord(recordContext) {
                return {
                  async evaluate() {
                    return {
                      observations: recordContext.metrics.map((metric) => {
                        if (metric.valueType === 'numeric') return {
                          metricId: metric.metricId,
                          observationStatus: 'observed' as const,
                          valueType: metric.valueType,
                          value: 1,
                        };
                        if (metric.valueType === 'boolean') return {
                          metricId: metric.metricId,
                          observationStatus: 'observed' as const,
                          valueType: metric.valueType,
                          value: true,
                        };
                        if (metric.valueType === 'ranking') return {
                          metricId: metric.metricId,
                          observationStatus: 'observed' as const,
                          valueType: metric.valueType,
                          value: ['A'],
                        };
                        return {
                          metricId: metric.metricId,
                          observationStatus: 'observed' as const,
                          valueType: metric.valueType,
                          value: 'A',
                        };
                      }),
                    };
                  },
                  dispose() { lifecycle.push(`evaluator.record.dispose:${runContext.runId}`); },
                };
              },
              dispose() { lifecycle.push(`evaluator.run.dispose:${runContext.runId}`); },
            };
          },
        },
      };
    });
  }
  return {
    ...base,
    executorsByImplementationId: executors,
    evaluatorsByImplementationId: evaluators,
  };
}

const clock = {
  monotonicNow: () => 0,
  timestamp: () => '2026-08-30T00:00:00.000Z',
  async sleep(_delayMs: number, signal: AbortSignal) {
    if (signal.aborted) throw new Error('aborted');
  },
};

function compositionInput(options: {
  judges?: boolean;
  referenceOutput?: boolean;
  referenceTrace?: boolean;
  referenceEvaluationEvidence?: boolean;
} = {}) {
  const input = runtimeAssemblyInput();
  delete input.orchestration.independentSeries;
  delete input.orchestration.gold;
  input.judges.enabled = options.judges ?? true;
  input.policy.evidence = {
    output: options.referenceOutput === true ? 'reference' : 'full',
    trace: options.referenceTrace === true ? 'reference' : 'full',
    evidence: options.referenceEvaluationEvidence === true ? 'reference' : 'full',
    maximumClassification: 'gold',
  };
  return compileCliEvaluationInput(input);
}

function compositionSupport(): OmkEvaluationRuntimeSupportPorts {
  return {
    clock,
    schemaValidators: testRuntime({
      evaluatorValueTypes: ['numeric', 'boolean', 'categorical', 'text', 'ranking'],
    }).schemaValidators,
  };
}

function fakeLeases(
  runId: string,
  bindings: readonly OmkBindingResourceLeaseRequest[],
  hostResources: ResolvedHostResources,
  dispose: () => void,
): OmkRunResourceLeases {
  const byBinding = new Map<string, OmkBindingResourceLease>(bindings.map((binding) => [
    binding.bindingId,
    Object.freeze({
      bindingId: binding.bindingId,
      consumerKind: binding.consumerKind,
      resourcesByResourceId: new Map(binding.requirements.map((requirement) => {
        const resolved = hostResources.resources.find((resource) => (
          resource.descriptor.resourceId === requirement.resourceId
        ));
        if (resolved === undefined) throw new Error('missing HostResource fixture');
        return [requirement.resourceId, requirement.leaseMode === 'copy-on-write-overlay'
          ? {
              resourceId: requirement.resourceId,
              resourceKind: 'workspace' as const,
              descriptor: resolved.descriptor,
              snapshotKind: 'directory' as const,
              leaseMode: requirement.leaseMode,
              baseSnapshotPath: `/lease/${runId}/${requirement.resourceId}/base`,
              overlayPath: `/lease/${runId}/${binding.bindingId}/${requirement.resourceId}/overlay`,
            }
          : {
              resourceId: requirement.resourceId,
              resourceKind: resolved.resourceKind,
              descriptor: resolved.descriptor,
              snapshotKind: 'file' as const,
              leaseMode: requirement.leaseMode,
              snapshotPath: `/lease/${runId}/${requirement.resourceId}`,
            }];
      })),
    }),
  ]));
  return Object.freeze({
    runId,
    bindingsByBindingId: byBinding,
    analysisOnlyResourcesByResourceId: new Map(),
    async dispose() { dispose(); },
  });
}

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
    const leaseRequests = resourceLeaseRequestsFromBindingEntries(
      assembly.evaluation.entries,
    );
    expect(leaseRequests).toHaveLength(compiled.definition.targets.length
      + compiled.definition.evaluators.length);
    expect(JSON.stringify(leaseRequests)).not.toContain('gold-dataset');
    expect(Object.isFrozen(leaseRequests)).toBe(true);
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

describe('OMK Evaluation Runtime composition root', () => {
  it('uses the verified Node materializer by default and fails closed on missing sources', async () => {
    const compiled = compositionInput();
    const lifecycle: string[] = [];
    const leaseRoot = await mkdtemp(join(tmpdir(), 'omk-composition-test-'));
    try {
      const runtime = await createOmkEvaluationRuntime({
        compiled,
        factories: runnableFactoriesFor(compiled, lifecycle),
        support: compositionSupport(),
        resources: { leaseRoot },
      });
      const prepared = await runtime.prepare();

      await expect(prepared.start({ runId: 'node-materializer' })).rejects.toMatchObject({
        code: 'OMK_RESOURCE_LEASE_SOURCE_INVALID',
      });
      expect(lifecycle.some((entry) => entry.startsWith('executor.open:'))).toBe(false);
    } finally {
      await rm(leaseRoot, { recursive: true, force: true });
    }
  });

  it('runs real Core prepare and acquires leases before any Runtime port opens', async () => {
    const compiled = compositionInput();
    const lifecycle: string[] = [];
    let disposeCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, lifecycle),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          lifecycle.push(`lease.acquire:${request.runId}`);
          return fakeLeases(request.runId, request.bindings, request.hostResources, () => {
            disposeCalls += 1;
            lifecycle.push(`lease.dispose:${request.runId}`);
          });
        },
      },
    });

    const prepared = await runtime.prepare();
    expect(digestCanonicalJson(prepared.plan.definition)).toBe(compiled.canonicalDigests.definition);
    expect(lifecycle).toEqual([]);
    const run = await prepared.start({ runId: 'composition-run' });
    const result = await run.result;

    expect(result.status).toBe('failed');
    expect(lifecycle[0]).toBe('lease.acquire:composition-run');
    expect(lifecycle.findIndex((entry) => entry.startsWith('executor.open:composition-run:')))
      .toBeGreaterThan(0);
    expect(lifecycle.at(-1)).toBe('lease.dispose:composition-run');
    expect(disposeCalls).toBe(1);
  });

  it('fails missing Policy-required support ports before invoking any Runtime factory', async () => {
    const compiled = compositionInput({ referenceTrace: true });
    const factoryCalls: string[] = [];

    await expect(createOmkEvaluationRuntime({
      compiled,
      factories: factoriesFor(compiled, factoryCalls),
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    })).rejects.toMatchObject({
      code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_REQUIRED',
      fieldPath: 'support.executionContentStore',
    });
    expect(factoryCalls).toEqual([]);
    expect(compiled.policy.evidence.trace).toBe('reference');
  });

  it.each([
    {
      evidence: { referenceOutput: true },
      support: { executionContentStore: { async put() { throw new Error('unused'); } } },
      fieldPath: 'support.contentResolver',
    },
    {
      evidence: { referenceEvaluationEvidence: true },
      support: {},
      fieldPath: 'support.evaluationContentStore',
    },
  ])('fails $fieldPath before factory assembly', async ({ evidence, support, fieldPath }) => {
    const compiled = compositionInput(evidence);
    const calls: string[] = [];

    await expect(createOmkEvaluationRuntime({
      compiled,
      factories: factoriesFor(compiled, calls),
      support: { ...compositionSupport(), ...support },
      resources: { leaseRoot: '/unused-test-lease-root' },
    })).rejects.toMatchObject({
      code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_REQUIRED',
      fieldPath,
    });
    expect(calls).toEqual([]);
  });

  it.each(['execution-cache', 'required-writer'] as const)(
    'fails a missing %s port before factory assembly',
    async (scenario) => {
      const input = runtimeAssemblyInput();
      delete input.orchestration.independentSeries;
      delete input.orchestration.resumeSourceLocator;
      delete input.orchestration.gold;
      input.policy.evidence = {
        output: 'full', trace: 'full', evidence: 'full', maximumClassification: 'gold',
      };
      if (scenario === 'execution-cache') {
        input.policy.cache.executionMode = 'replay-only';
        input.orchestration.cacheSources = { executionSourceLocator: '/cache/source' };
      } else {
        input.policy.eventDelivery = {
          writerMode: 'required', backpressureMode: 'block', writerFailureMode: 'fail-run',
        };
      }
      const compiled = compileCliEvaluationInput(input);
      const calls: string[] = [];

      await expect(createOmkEvaluationRuntime({
        compiled,
        factories: factoriesFor(compiled, calls),
        support: compositionSupport(),
        resources: { leaseRoot: '/unused-test-lease-root' },
      })).rejects.toMatchObject({
        code: 'OMK_EVALUATION_RUNTIME_SUPPORT_PORT_REQUIRED',
        fieldPath: scenario === 'execution-cache'
          ? 'support.executionCache'
          : 'support.createEventWriter',
      });
      expect(calls).toEqual([]);
    },
  );

  it('does not construct or probe Judge Runtime when no Judge binding exists', async () => {
    const compiled = compositionInput({ judges: false });
    const lifecycle: string[] = [];
    const factories = runnableFactoriesFor(compiled, lifecycle);
    let judgeSideEffects = 0;
    const evaluators = new Map(factories.evaluatorsByImplementationId);
    evaluators.set('test.unbound-judge/v1', () => {
      judgeSideEffects += 1;
      throw new Error('credential and connectivity side effect must stay unreachable');
    });

    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: { ...factories, evaluatorsByImplementationId: evaluators },
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });
    await runtime.prepare();

    expect(compiled.runtimeBinding.bindings.some((binding) => (
      binding.runtimeKind === 'evaluator' && binding.qualification !== undefined
    ))).toBe(false);
    expect(judgeSideEffects).toBe(0);
    expect(lifecycle).toEqual([]);
  });

  it('does not materialize post-hoc Gold for the single-run Core pipeline', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    input.policy.evidence = {
      output: 'full', trace: 'full', evidence: 'full', maximumClassification: 'gold',
    };
    const compiled = compileCliEvaluationInput(input);
    let materializeCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, []),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          materializeCalls += 1;
          expect(request.analysisOnly).toEqual([]);
          expect(JSON.stringify(request.bindings)).not.toContain('gold-dataset');
          return fakeLeases(
            request.runId,
            request.bindings,
            request.hostResources,
            () => {},
          );
        },
      },
    });
    const run = await (await runtime.prepare()).start({ runId: 'no-core-gold' });
    await run.result;

    expect(compiled.orchestration.gold?.comparisonMode).toBe('exploratory-post-hoc');
    expect(materializeCalls).toBe(1);
  });

  it('rejects duplicate active runId before acquiring a second lease and isolates cleanup', async () => {
    const compiled = compositionInput();
    let releaseExecution: (() => void) | undefined;
    const executeGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const lifecycle: string[] = [];
    let acquireCalls = 0;
    let disposeCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, lifecycle, executeGate),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          acquireCalls += 1;
          return fakeLeases(
            request.runId,
            request.bindings,
            request.hostResources,
            () => { disposeCalls += 1; },
          );
        },
      },
    });
    const prepared = await runtime.prepare();
    const first = await prepared.start({ runId: 'same-run' });
    await expect(prepared.start({ runId: 'same-run' })).rejects.toMatchObject({
      code: 'OMK_EVALUATION_RUNTIME_RUN_ACTIVE',
    });
    expect(acquireCalls).toBe(1);

    releaseExecution?.();
    await first.result;
    expect(disposeCalls).toBe(1);
  });

  it('rejects invalid run options before resource acquisition', async () => {
    const compiled = compositionInput();
    let acquireCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, []),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          acquireCalls += 1;
          return fakeLeases(
            request.runId,
            request.bindings,
            request.hostResources,
            () => {},
          );
        },
      },
    });
    const prepared = await runtime.prepare();

    await expect(prepared.start({
      runId: 'invalid-options',
      eventBufferCapacity: 0,
    })).rejects.toMatchObject({
      code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
      fieldPath: 'eventBufferCapacity',
    });
    expect(acquireCalls).toBe(0);
  });

  it('keeps two concurrent run lease projections and teardown independent', async () => {
    const compiled = compositionInput();
    let releaseExecution: (() => void) | undefined;
    const executeGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const lifecycle: string[] = [];
    const disposed: string[] = [];
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, lifecycle, executeGate),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          lifecycle.push(`lease.acquire:${request.runId}`);
          return fakeLeases(
            request.runId,
            request.bindings,
            request.hostResources,
            () => disposed.push(request.runId),
          );
        },
      },
    });
    const prepared = await runtime.prepare();
    const first = await prepared.start({ runId: 'parallel-a' });
    const second = await prepared.start({ runId: 'parallel-b' });

    releaseExecution?.();
    await Promise.all([first.result, second.result]);
    expect(lifecycle.filter((entry) => entry.startsWith('lease.acquire:')).sort()).toEqual([
      'lease.acquire:parallel-a',
      'lease.acquire:parallel-b',
    ]);
    expect(lifecycle.some((entry) => entry.startsWith('executor.open:parallel-a:'))).toBe(true);
    expect(lifecycle.some((entry) => entry.startsWith('executor.open:parallel-b:'))).toBe(true);
    expect(disposed.sort()).toEqual(['parallel-a', 'parallel-b']);
  });

  it('rejects writable overlay reuse across active runs before opening the second run', async () => {
    const compiled = compositionInput();
    let releaseExecution: (() => void) | undefined;
    const executeGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const disposed: string[] = [];
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, [], executeGate),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          const leases = fakeLeases(
            request.runId,
            request.bindings,
            request.hostResources,
            () => disposed.push(request.runId),
          );
          for (const binding of leases.bindingsByBindingId.values()) {
            for (const resource of binding.resourcesByResourceId.values()) {
              if (resource.leaseMode === 'copy-on-write-overlay') {
                (resource as { overlayPath: string }).overlayPath =
                  `/lease/shared-overlay/${binding.bindingId}`;
              }
            }
          }
          return leases;
        },
      },
    });
    const prepared = await runtime.prepare();
    const first = await prepared.start({ runId: 'overlay-a' });

    await expect(prepared.start({ runId: 'overlay-b' })).rejects.toMatchObject({
      code: 'OMK_RESOURCE_LEASE_ISOLATION_MISMATCH',
    });
    releaseExecution?.();
    await first.result;
    expect(disposed.sort()).toEqual(['overlay-a', 'overlay-b']);
  });

  it('cleans an acquired lease without opening a port when cancellation wins acquisition', async () => {
    const compiled = compositionInput();
    const lifecycle: string[] = [];
    const controller = new AbortController();
    let finishAcquisition: (() => void) | undefined;
    const acquisitionGate = new Promise<void>((resolve) => { finishAcquisition = resolve; });
    let disposeCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, lifecycle),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          lifecycle.push(`lease.acquire:${request.runId}`);
          await acquisitionGate;
          return fakeLeases(
            request.runId,
            request.bindings,
            request.hostResources,
            () => { disposeCalls += 1; },
          );
        },
      },
    });
    const prepared = await runtime.prepare();
    const start = prepared.start({ runId: 'cancel-acquisition', signal: controller.signal });
    controller.abort();
    finishAcquisition?.();

    await expect(start).rejects.toMatchObject({
      code: 'OMK_EVALUATION_RUNTIME_RUN_ABORTED_BEFORE_START',
    });
    expect(lifecycle.some((entry) => entry.startsWith('executor.open:'))).toBe(false);
    expect(disposeCalls).toBe(1);
  });

  it('rejects incomplete binding resource coverage before opening any Runtime port', async () => {
    const compiled = compositionInput();
    const lifecycle: string[] = [];
    let disposeCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, lifecycle),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          const leases = fakeLeases(
            request.runId,
            request.bindings,
            request.hostResources,
            () => { disposeCalls += 1; },
          );
          const first = [...leases.bindingsByBindingId.values()].find((lease) => (
            lease.resourcesByResourceId.size > 0
          ));
          if (first === undefined) throw new Error('missing resource lease fixture');
          const resources = first.resourcesByResourceId as Map<string, unknown>;
          resources.delete(resources.keys().next().value as string);
          return leases;
        },
      },
    });
    const prepared = await runtime.prepare();

    await expect(prepared.start({ runId: 'incomplete-resources' })).rejects.toMatchObject({
      code: 'OMK_RESOURCE_LEASE_BINDING_COVERAGE_MISMATCH',
    });
    expect(lifecycle.some((entry) => entry.startsWith('executor.open:'))).toBe(false);
    expect(disposeCalls).toBe(1);
  });

  it('normalizes an unknown materializer exception without exposing sensitive details', async () => {
    const compiled = compositionInput();
    const lifecycle: string[] = [];
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, lifecycle),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize() {
          throw new Error('secret locator and credential details');
        },
      },
    });
    const prepared = await runtime.prepare();

    const error = await prepared.start({ runId: 'materializer-failure' }).catch((cause) => cause);
    expect(error).toMatchObject({ code: 'OMK_EVALUATION_RUNTIME_RESOURCE_LEASE_FAILED' });
    expect(error.message).not.toContain('secret');
    expect(error.cause).toBeUndefined();
    expect(lifecycle.some((entry) => entry.startsWith('executor.open:'))).toBe(false);
  });

  it('cleans an acquired lease exactly once when EventWriter creation fails', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    delete input.orchestration.gold;
    input.policy.evidence = {
      output: 'full', trace: 'full', evidence: 'full', maximumClassification: 'gold',
    };
    input.policy.eventDelivery = {
      writerMode: 'required', backpressureMode: 'block', writerFailureMode: 'fail-run',
    };
    const compiled = compileCliEvaluationInput(input);
    let disposeCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, []),
      support: {
        ...compositionSupport(),
        createEventWriter() { throw new Error('writer unavailable'); },
      },
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          return fakeLeases(
            request.runId,
            request.bindings,
            request.hostResources,
            () => { disposeCalls += 1; },
          );
        },
      },
    });
    const prepared = await runtime.prepare();

    await expect(prepared.start({ runId: 'writer-failure' })).rejects.toMatchObject({
      code: 'OMK_EVALUATION_RUNTIME_EVENT_WRITER_FAILED',
    });
    expect(disposeCalls).toBe(1);
  });

  it('does not create an EventWriter when sealed writerMode is disabled', async () => {
    const compiled = compositionInput();
    let writerCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, []),
      support: {
        ...compositionSupport(),
        createEventWriter() {
          writerCalls += 1;
          return { async write() {} };
        },
      },
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          return fakeLeases(
            request.runId,
            request.bindings,
            request.hostResources,
            () => {},
          );
        },
      },
    });
    const run = await (await runtime.prepare()).start({ runId: 'writer-disabled' });
    await run.result;

    expect(compiled.policy.eventDelivery.writerMode).toBe('disabled');
    expect(writerCalls).toBe(0);
  });

  it('reports lease disposal failure without retrying destructive cleanup', async () => {
    const compiled = compositionInput();
    let disposeCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, []),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
          return fakeLeases(request.runId, request.bindings, request.hostResources, () => {
            disposeCalls += 1;
            throw new Error('cannot remove lease');
          });
        },
      },
    });
    const run = await (await runtime.prepare()).start({ runId: 'dispose-failure' });

    await expect(run.result).rejects.toMatchObject({
      code: 'OMK_EVALUATION_RUNTIME_CLEANUP_FAILED',
    });
    expect(disposeCalls).toBe(1);
  });

  it('fails conflicting SchemaValidator identities and cache sources without rewriting Policy', async () => {
    const compiled = compositionInput();
    const support = compositionSupport();
    const validators = new Map(support.schemaValidators);
    const first = validators.values().next().value as CoreSchemaValidator;
    validators.set(schemaIdentityKey({
      ...first.schema,
      schemaVersion: `${first.schema.schemaVersion}.conflict`,
    }), {
      schema: { ...first.schema, schemaVersion: `${first.schema.schemaVersion}.conflict` },
      parse: first.parse,
    });

    await expect(createOmkEvaluationRuntime({
      compiled,
      factories: factoriesFor(compiled, []),
      support: { ...support, schemaValidators: validators },
      resources: { leaseRoot: '/unused-test-lease-root' },
    })).rejects.toMatchObject({ code: 'OMK_EVALUATION_RUNTIME_SCHEMA_VALIDATOR_CONFLICT' });

    const cacheInput = runtimeAssemblyInput();
    delete cacheInput.orchestration.independentSeries;
    delete cacheInput.orchestration.resumeSourceLocator;
    cacheInput.policy.cache.executionMode = 'replay-only';
    cacheInput.orchestration.cacheSources = { executionSourceLocator: '/cache/source-a' };
    cacheInput.policy.evidence = {
      output: 'full', trace: 'full', evidence: 'full', maximumClassification: 'gold',
    };
    const cacheCompiled = compileCliEvaluationInput(cacheInput);
    await expect(createOmkEvaluationRuntime({
      compiled: cacheCompiled,
      factories: factoriesFor(cacheCompiled, []),
      support: {
        ...compositionSupport(),
        executionCache: {
          sourceLocator: '/cache/source-b',
          port: { async get() { return undefined; }, async put() {} },
        },
      },
      resources: { leaseRoot: '/unused-test-lease-root' },
    })).rejects.toMatchObject({ code: 'OMK_EVALUATION_RUNTIME_CACHE_SOURCE_MISMATCH' });
    expect(cacheCompiled.policy.cache.executionMode).toBe('replay-only');
  });
});
