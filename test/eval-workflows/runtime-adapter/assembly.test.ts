import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
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
  OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
  createSameProcessEvaluatorAdapter,
  createSameProcessExecutorAdapter,
  ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
  DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
  COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
  COMPOSITE_PARAMETERS_SCHEMA,
  COMPOSITE_TABLE_SCHEMA,
  BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
  BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA,
  BOOTSTRAP_FAMILY_TABLE_SCHEMA,
  AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
  AGREEMENT_PARAMETERS_SCHEMA,
  AGREEMENT_TABLE_SCHEMA,
  RELEASE_DECISION_PARAMETERS_SCHEMA,
  RELEASE_DECISION_POLICY_IMPLEMENTATION_ID,
  JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
  JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
  resourceLeaseRequestsFromBindingEntries,
  type OmkBindingResourceLease,
  type OmkBindingResourceLeaseRequest,
  type OmkEvaluationRuntimeSupportPorts,
  type OmkRuntimePreflightDeclaration,
  type OmkRuntimePreflightContext,
  type OmkRunResourceLeases,
  type OmkRuntimeBindingFactories,
  type RuntimeBindingOf,
} from '../../../src/eval-workflows/runtime-adapter/index.js';
import {
  compileCliEvaluationInput,
  type ResolvedHostResources,
  type RuntimeBinding,
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
    template.implementationId = `test.evaluator.${template.evaluatorId}/v1`;
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

function normalizedAnalysisCapabilities(input: RuntimeIdentity['capabilities']): JsonValue {
  const capabilities = structuredClone(input) as unknown as Record<string, unknown>;
  const sortStrings = (value: unknown): void => {
    if (Array.isArray(value)) (value as string[]).sort();
  };
  sortStrings(capabilities.analysisNodeKinds);
  sortStrings(capabilities.analysisResultSchemaUris);
  sortStrings(capabilities.multipleComparisonPolicyIds);
  sortStrings(capabilities.valueTypes);
  const sampling = capabilities.sampling as Record<string, unknown> | undefined;
  if (sampling !== undefined) {
    sortStrings(sampling.experimentalUnits);
    if (Array.isArray(sampling.repeatedMeasures)) sampling.repeatedMeasures.sort();
    sortStrings(sampling.resamplingUnits);
  }
  if (Array.isArray(capabilities.inputDomains)) {
    for (const domain of capabilities.inputDomains as Array<Record<string, unknown>>) {
      sortStrings(domain.valueTypes);
      sortStrings(domain.missingPolicyIds);
      sortStrings(domain.schemaUris);
    }
    capabilities.inputDomains.sort((left, right) => (
      canonicalizeJson(left as JsonValue).localeCompare(canonicalizeJson(right as JsonValue))
    ));
  }
  if (Array.isArray(capabilities.schemas)) {
    capabilities.schemas.sort((left, right) => (
      canonicalizeJson(left as JsonValue).localeCompare(canonicalizeJson(right as JsonValue))
    ));
  }
  return capabilities as JsonValue;
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

function testPreflightDeclarations(
  binding: RuntimeBinding,
): readonly OmkRuntimePreflightDeclaration[] {
  if (binding.runtimeKind !== 'executor' && binding.runtimeKind !== 'evaluator') return [];
  const declarations: OmkRuntimePreflightDeclaration[] = [];
  if (binding.runtimeKind === 'executor') {
    declarations.push({
      preflightKind: 'doctor',
      checkId: 'test-doctor',
      preflightDisposition: 'check',
      run() {},
    });
  }
  if (binding.runtimeKind === 'executor' || binding.qualification !== undefined) {
    declarations.push({
      preflightKind: 'credential',
      checkId: 'test-credential',
      preflightDisposition: 'not-required',
      reasonCode: 'test-runtime-has-no-credential',
    }, {
      preflightKind: 'connectivity',
      checkId: 'test-connectivity',
      preflightDisposition: 'check',
      run() {},
    });
  }
  if (binding.resourceLeaseRequirements.length > 0) declarations.push({
    preflightKind: 'filesystem',
    checkId: 'test-filesystem',
    preflightDisposition: 'check',
    run() {},
  });
  if (binding.resourceLeaseRequirements.some((requirement) => (
    requirement.resourceRole === 'mcp-config'
  ))) declarations.push({
    preflightKind: 'mcp-readiness',
    checkId: 'test-mcp',
    preflightDisposition: 'check',
    run() {},
  });
  if (binding.resourceLeaseRequirements.some((requirement) => (
    requirement.resourceRole === 'mock-payload'
  ))) declarations.push({
    preflightKind: 'mock-readiness',
    checkId: 'test-mock',
    preflightDisposition: 'check',
    run() {},
  });
  return declarations;
}

type PreflightObserver = (input: Readonly<{
  bindingId: string;
  declaration: Extract<OmkRuntimePreflightDeclaration, {
    preflightDisposition: 'check';
  }>;
  context: Readonly<OmkRuntimePreflightContext>;
  next: () => void | Promise<void>;
}>) => void | Promise<void>;

function observePreflight(
  factories: OmkRuntimeBindingFactories,
  observer: PreflightObserver,
): OmkRuntimeBindingFactories {
  const wrapDeclarations = (
    bindingId: string,
    declarations: readonly OmkRuntimePreflightDeclaration[],
  ): readonly OmkRuntimePreflightDeclaration[] => declarations.map((candidate) => {
    if (candidate.preflightDisposition === 'not-required') return candidate;
    const run = candidate.run;
    return {
      ...candidate,
      async run(context: Readonly<OmkRuntimePreflightContext>) {
        await observer({
          bindingId,
          declaration: candidate,
          context,
          next: () => run(context),
        });
      },
    };
  });
  const executors = new Map(factories.executorsByImplementationId);
  for (const [implementationId, factory] of executors) {
    executors.set(implementationId, async (context) => {
      const result = await factory(context);
      return {
        ...result,
        preflightDeclarations: wrapDeclarations(
          context.binding.bindingId,
          result.preflightDeclarations,
        ),
      };
    });
  }
  const evaluators = new Map(factories.evaluatorsByImplementationId);
  for (const [implementationId, factory] of evaluators) {
    evaluators.set(implementationId, async (context) => {
      const result = await factory(context);
      return {
        ...result,
        preflightDeclarations: wrapDeclarations(
          context.binding.bindingId,
          result.preflightDeclarations,
        ),
      };
    });
  }
  return {
    ...factories,
    executorsByImplementationId: executors,
    evaluatorsByImplementationId: evaluators,
  };
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
          executionRequirements: request.qualification.executionRequirements,
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
        return {
          port,
          satisfiesVersionConstraint: true,
          preflightDeclarations: testPreflightDeclarations(request),
        };
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
        const capabilities = structuredClone(resolved.identity.capabilities) as {
          inputSourceKinds: string[];
          metricValueTypes: string[];
          schemas: SchemaIdentity[];
        };
        capabilities.inputSourceKinds.sort();
        capabilities.metricValueTypes.sort();
        capabilities.schemas.sort((left, right) => left.schemaUri.localeCompare(right.schemaUri));
        const identity = bindingIdentity(
          request.implementationId,
          request.evaluatorId,
          resolved.identity,
          capabilities,
        );
        const port: EvaluationEvaluator = {
          identity,
          async openRun() { throw new Error('test prepare must not open an Evaluator'); },
        };
        return {
          port,
          satisfiesVersionConstraint: true,
          preflightDeclarations: testPreflightDeclarations(request),
        };
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
          normalizedAnalysisCapabilities(capabilities),
        );
        const port: AnalysisNodeImplementation = {
          identity,
          outputSchema: outputSchema(identity),
          async openRun() { throw new Error('test prepare must not open Analysis'); },
        };
        return { port, satisfiesVersionConstraint: true, preflightDeclarations: [] };
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
            normalizedAnalysisCapabilities(resolved.identity.capabilities),
          ),
          decide: () => 'exclude',
        };
        return { port, satisfiesVersionConstraint: true, preflightDeclarations: [] };
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
            normalizedAnalysisCapabilities(resolved.identity.capabilities),
          ),
          async decide() {
            return { decisionStatus: 'not-decided', reasonCodes: ['test-only'] };
          },
        };
        return { port, satisfiesVersionConstraint: true, preflightDeclarations: [] };
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
        return { port, satisfiesVersionConstraint: true, preflightDeclarations: [] };
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
        port: createSameProcessExecutorAdapter({
          identity: resolved.port.identity,
          sessionIsolationKey: context.sessionIsolationKey,
          resourceLeases: context.resourceLeases,
          implementation: {
            openRun({ run, resources }) {
              lifecycle.push(`executor.open:${run.runId}:${resources.bindingId}`);
              return { runId: run.runId };
            },
            openTrial({ trial }) { return { trialId: trial.trialId }; },
            async execute({ trial, attempt }) {
              if (attempt.signal.aborted) throw attempt.signal.reason;
              if (executeGate !== undefined) await executeGate;
              if (attempt.signal.aborted) throw attempt.signal.reason;
              const trialInput = trial.input as Readonly<Record<string, JsonValue>>;
              const answer = typeof trialInput.question === 'string'
                ? trialInput.question.replace(/^Q/, 'A')
                : 'test-output';
              return {
                output: {
                  value: { answer },
                  classification: 'public' as const,
                },
                trace: {
                  value: { source: 'test.omk.same-process-executor/v1' },
                  classification: 'public' as const,
                },
              };
            },
            disposeTrial({ run }) {
              lifecycle.push(`executor.trial.dispose:${run.runId}`);
            },
            disposeRun({ run }) { lifecycle.push(`executor.run.dispose:${run.runId}`); },
          },
        }),
      };
    });
  }
  const evaluators = new Map(base.evaluatorsByImplementationId);
  for (const [implementationId, factory] of evaluators) {
    evaluators.set(implementationId, async (context) => {
      const resolved = await factory(context);
      return {
        ...resolved,
        port: createSameProcessEvaluatorAdapter({
          identity: resolved.port.identity,
          sessionIsolationKey: context.sessionIsolationKey,
          resourceLeases: context.resourceLeases,
          implementation: {
            openRun({ run, resources }) {
              lifecycle.push(`evaluator.open:${run.runId}:${resources.bindingId}`);
              return { runId: run.runId };
            },
            openRecord({ record }) { return { evaluationId: record.evaluationId }; },
            async evaluate({ record, attempt }) {
              if (attempt.signal.aborted) throw attempt.signal.reason;
              const actual = record.bindings.find((binding) => binding.bindingId === 'actual')?.value;
              const expected = record.bindings.find((binding) => (
                binding.bindingId === 'expected'
              ))?.value;
              const equivalent = actual === undefined || expected === undefined
                ? record.bindings.length > 0
                : JSON.stringify(actual) === JSON.stringify(expected);
              return {
                observations: record.metrics.map((metric) => {
                  if (metric.valueType === 'numeric') return {
                    metricId: metric.metricId,
                    observationStatus: 'observed' as const,
                    valueType: metric.valueType,
                    value: equivalent ? (metric.scale?.max ?? 1) : (metric.scale?.min ?? 0),
                  };
                  if (metric.valueType === 'boolean') return {
                    metricId: metric.metricId,
                    observationStatus: 'observed' as const,
                    valueType: metric.valueType,
                    value: equivalent,
                  };
                  if (metric.valueType === 'ranking') return {
                    metricId: metric.metricId,
                    observationStatus: 'observed' as const,
                    valueType: metric.valueType,
                    value: record.bindings.map((binding) => binding.bindingId),
                  };
                  return {
                    metricId: metric.metricId,
                    observationStatus: 'observed' as const,
                    valueType: metric.valueType,
                    value: equivalent ? 'equivalent' : 'different',
                  };
                }),
              };
            },
            disposeRecord({ run }) {
              lifecycle.push(`evaluator.record.dispose:${run.runId}`);
            },
            disposeRun({ run }) { lifecycle.push(`evaluator.run.dispose:${run.runId}`); },
          },
        }),
      };
    });
  }
  const analysisNodes = new Map(base.analysisNodesByImplementationId);
  for (const [implementationId, factory] of analysisNodes) {
    analysisNodes.set(implementationId, async (context) => {
      const resolved = await factory(context);
      return {
        ...resolved,
        port: {
          ...resolved.port,
          async openRun() {
            return {
              async execute() {
                return { analysisStatus: 'inconclusive' as const, reasonCodes: ['test-only'] };
              },
              dispose() {},
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
    analysisNodesByImplementationId: analysisNodes,
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
  executionTimeout?: boolean;
  evaluationTimeout?: boolean;
  providerCostBudget?: boolean;
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
  if (options.executionTimeout === false) delete input.policy.executionTimeoutMs;
  if (options.evaluationTimeout === false) delete input.policy.evaluationTimeoutMs;
  if (options.providerCostBudget === false) {
    if (input.policy.budget === undefined) throw new Error('missing test budget');
    delete input.policy.budget.totalProviderCostUSD;
    delete input.policy.budget.perCoordinateProviderCostUSD;
  }
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

  it.each(['missing', 'mismatched', 'resource-mismatched', 'requirement-mismatched'] as const)(
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
      } else if (scenario === 'resource-mismatched') {
        const executor = request.bindings.find((binding) => binding.runtimeKind === 'executor');
        if (executor?.runtimeKind !== 'executor') throw new Error('missing fixture binding');
        executor.resourceLeaseRequirements.pop();
      } else {
        const executor = request.bindings.find((binding) => binding.runtimeKind === 'executor');
        if (executor?.runtimeKind !== 'executor') throw new Error('missing fixture binding');
        executor.qualification.executionRequirements.systemInstructions =
          executor.qualification.executionRequirements.systemInstructions === 'required'
            ? 'not-required'
            : 'required';
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

  it('rejects the superseded v2 binding request without compatibility inference', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    const compiled = compileCliEvaluationInput(input);
    const request = clone(compiled.runtimeBinding) as { schemaVersion: string };
    request.schemaVersion = 'omk.runtime-binding-request/v2';
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
    executors.set(implementationId, () => ({
      port,
      satisfiesVersionConstraint: true,
      preflightDeclarations: [],
    }));

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
      executionRequirements: compiled.definition.targets[0].executionRequirements,
    });
    (factories.executorsByImplementationId as Map<string, unknown>).clear();
    const after = await assembly.evaluation.bindings.resolveExecutor({
      referenceId: targetId,
      executorId: compiled.definition.targets[0].executorId,
      ...(compiled.definition.targets[0].versionConstraint === undefined ? {} : {
        versionConstraint: compiled.definition.targets[0].versionConstraint,
      }),
      protocolId: compiled.definition.targets[0].protocolId,
      executionRequirements: compiled.definition.targets[0].executionRequirements,
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
    expect(builtins.analysisNodesByImplementationId.has(
      ASSERTION_LAYER_ANALYSIS_IMPLEMENTATION_ID,
    )).toBe(true);
    expect(builtins.analysisNodesByImplementationId.has(
      JUDGE_REPLICATE_ANALYSIS_IMPLEMENTATION_ID,
    )).toBe(true);
    expect(builtins.analysisNodesByImplementationId.has(
      JUDGE_ENSEMBLE_ANALYSIS_IMPLEMENTATION_ID,
    )).toBe(true);
    expect(builtins.analysisNodesByImplementationId.has(
      DIMENSION_ANALYSIS_IMPLEMENTATION_ID,
    )).toBe(true);
    expect(builtins.analysisNodesByImplementationId.has(
      COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
    )).toBe(true);
    expect(builtins.analysisNodesByImplementationId.has(
      BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
    )).toBe(true);
    expect(builtins.analysisNodesByImplementationId.has(
      AGREEMENT_ANALYSIS_IMPLEMENTATION_ID,
    )).toBe(true);
    expect(builtins.missingPoliciesByImplementationId.has('exclude/v1')).toBe(true);
    expect(builtins.decisionPoliciesByImplementationId.has('progress/v1')).toBe(true);
    expect(builtins.decisionPoliciesByImplementationId.has(
      RELEASE_DECISION_POLICY_IMPLEMENTATION_ID,
    )).toBe(true);
  });
});

describe('OMK Evaluation Runtime composition root', () => {
  it('reserves the built-in output assertion Evaluator identity', async () => {
    const compiled = compositionInput();
    const factories = factoriesFor(compiled, []);
    const existingFactory = factories.evaluatorsByImplementationId.values().next().value;
    if (existingFactory === undefined) throw new Error('missing fixture evaluator factory');
    const evaluators = new Map(factories.evaluatorsByImplementationId);
    evaluators.set(OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID, existingFactory);

    await expect(createOmkEvaluationRuntime({
      compiled,
      factories: { ...factories, evaluatorsByImplementationId: evaluators },
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    })).rejects.toMatchObject({
      code: 'OMK_EVALUATION_RUNTIME_FACTORY_CONFLICT',
      fieldPath: 'factories.evaluatorsByImplementationId',
    });
  });

  it('fails capability mismatch during Core prepare before any Executor opens', async () => {
    const compiled = compositionInput();
    const factories = factoriesFor(compiled, []);
    const executors = new Map(factories.executorsByImplementationId);
    const implementationId = compiled.definition.targets[0].executorId;
    const original = executors.get(implementationId);
    if (original === undefined) throw new Error('missing fixture executor factory');
    let opens = 0;
    let preflightCalls = 0;
    executors.set(implementationId, async (context) => {
      const resolved = await original(context);
      const capabilities = clone(resolved.port.identity.capabilities) as {
        protocols: Array<{ execution: { features: { mcp: string[] } } }>;
      };
      for (const protocol of capabilities.protocols) protocol.execution.features.mcp = [];
      const identity = RuntimeIdentitySchema.parse({
        ...resolved.port.identity,
        capabilities,
      });
      const port: ExecutionExecutor = {
        ...resolved.port,
        identity,
        async openRun(runContext) {
          opens += 1;
          return resolved.port.openRun(runContext);
        },
      };
      return { ...resolved, port };
    });
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: observePreflight(
        { ...factories, executorsByImplementationId: executors },
        async ({ next }) => {
          preflightCalls += 1;
          await next();
        },
      ),
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });

    await expect(runtime.prepare()).rejects.toMatchObject({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      preparationStage: 'runtime-resolution',
    });
    expect(opens).toBe(0);
    expect(preflightCalls).toBe(0);
  });

  it('qualifies Independent Series Runtime before any preflight effect', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.gold;
    input.policy.evidence = {
      output: 'full', trace: 'full', evidence: 'full', maximumClassification: 'gold',
    };
    const compiled = compileCliEvaluationInput(input);
    const base = factoriesFor(compiled, []);
    const seriesFactories = new Map(base.seriesAnalysisNodesByImplementationId);
    for (const [implementationId, factory] of seriesFactories) {
      seriesFactories.set(implementationId, async (context) => {
        const result = await factory(context);
        const identity = RuntimeIdentitySchema.parse({
          ...result.port.identity,
          capabilities: { experimentalUnit: 'sample' },
        });
        return { ...result, port: { ...result.port, identity } };
      });
    }
    let preflightCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: observePreflight(
        { ...base, seriesAnalysisNodesByImplementationId: seriesFactories },
        async ({ next }) => {
          preflightCalls += 1;
          await next();
        },
      ),
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });

    await expect(runtime.prepare()).rejects.toThrow(
      'Series Analysis Runtime must match the declared implementation and run unit.',
    );
    expect(preflightCalls).toBe(0);
  });

  it('runs active-binding preflight in canonical order without exposing or changing the Plan', async () => {
    const compiled = compositionInput();
    const calls: string[] = [];
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: observePreflight(factoriesFor(compiled, []), async ({
        bindingId,
        declaration,
        context,
        next,
      }) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.bindingId).toBe(bindingId);
        expect(context).not.toHaveProperty('plan');
        expect(context).not.toHaveProperty('definition');
        expect(context).not.toHaveProperty('policy');
        calls.push(`${bindingId}:${declaration.preflightKind}:${declaration.checkId}`);
        await next();
      }),
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });

    const prepared = await runtime.prepare();
    const passed = prepared.preflight.records.filter((record) => (
      record.preflightStatus === 'passed'
    ));
    expect(calls).toEqual(passed.map((record) => (
      `${record.bindingId}:${record.preflightKind}:${record.checkId}`
    )));
    expect(Object.isFrozen(prepared.preflight)).toBe(true);
    expect(Object.isFrozen(prepared.preflight.records)).toBe(true);
    expect(digestCanonicalJson(prepared.plan.definition)).toBe(
      compiled.canonicalDigests.definition,
    );
    expect(digestCanonicalJson(prepared.plan.measurementPolicy)).toBe(
      compiled.canonicalDigests.policy,
    );
  });

  it('uses compiled skip modes only to suppress doctor and connectivity effects', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    delete input.orchestration.gold;
    input.orchestration.preflight = { doctor: 'skip', connectivity: 'skip' };
    input.policy.evidence = {
      output: 'full', trace: 'full', evidence: 'full', maximumClassification: 'gold',
    };
    const compiled = compileCliEvaluationInput(input);
    const calls: string[] = [];
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: observePreflight(
        factoriesFor(compiled, []),
        async ({ bindingId, declaration, next }) => {
          calls.push(`${bindingId}:${declaration.preflightKind}`);
          await next();
        },
      ),
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });

    const prepared = await runtime.prepare();
    expect(calls.some((call) => call.endsWith(':doctor'))).toBe(false);
    expect(calls.some((call) => call.endsWith(':connectivity'))).toBe(false);
    expect(prepared.preflight.records.filter((record) => (
      record.preflightKind === 'doctor' || record.preflightKind === 'connectivity'
    )).every((record) => record.preflightStatus === 'skipped')).toBe(true);
    expect(prepared.preflight.records.some((record) => (
      record.preflightKind === 'filesystem' && record.preflightStatus === 'passed'
    ))).toBe(true);
  });

  it('preserves not-required truth when connectivity callbacks are skipped', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    delete input.orchestration.gold;
    input.orchestration.preflight = { doctor: 'required', connectivity: 'skip' };
    input.policy.evidence = {
      output: 'full', trace: 'full', evidence: 'full', maximumClassification: 'gold',
    };
    const compiled = compileCliEvaluationInput(input);
    const base = factoriesFor(compiled, []);
    const executors = new Map(base.executorsByImplementationId);
    for (const [implementationId, factory] of executors) {
      executors.set(implementationId, async (context) => {
        const result = await factory(context);
        if (context.binding.targetId !== 'control') return result;
        return {
          ...result,
          preflightDeclarations: result.preflightDeclarations.map((candidate) => (
            candidate.preflightKind !== 'connectivity'
              ? candidate
              : {
                  preflightKind: 'connectivity' as const,
                  checkId: candidate.checkId,
                  preflightDisposition: 'not-required' as const,
                  reasonCode: 'local-runtime-no-connectivity',
                }
          )),
        };
      });
    }
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: { ...base, executorsByImplementationId: executors },
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });

    const prepared = await runtime.prepare();
    expect(prepared.preflight.records).toContainEqual(expect.objectContaining({
      bindingId: 'executor-control',
      preflightKind: 'connectivity',
      preflightStatus: 'not-required',
      reasonCode: 'local-runtime-no-connectivity',
    }));
  });

  it('accepts a required check when an earlier declaration of the same kind is not required', async () => {
    const compiled = compositionInput();
    const base = factoriesFor(compiled, []);
    const executors = new Map(base.executorsByImplementationId);
    for (const [implementationId, factory] of executors) {
      executors.set(implementationId, async (context) => {
        const result = await factory(context);
        if (context.binding.targetId !== 'control') return result;
        return {
          ...result,
          preflightDeclarations: [{
            preflightKind: 'doctor' as const,
            checkId: 'local-doctor-not-applicable',
            preflightDisposition: 'not-required' as const,
            reasonCode: 'local-doctor-not-applicable',
          }, ...result.preflightDeclarations],
        };
      });
    }
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: { ...base, executorsByImplementationId: executors },
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });

    const prepared = await runtime.prepare();
    expect(prepared.preflight.records.filter((record) => (
      record.bindingId === 'executor-control' && record.preflightKind === 'doctor'
    )).map((record) => record.preflightStatus)).toEqual(['not-required', 'passed']);
  });

  it('fails missing required declarations before effects even when the callback is skipped', async () => {
    const input = runtimeAssemblyInput();
    delete input.orchestration.independentSeries;
    delete input.orchestration.gold;
    input.orchestration.preflight = { doctor: 'skip', connectivity: 'skip' };
    input.policy.evidence = {
      output: 'full', trace: 'full', evidence: 'full', maximumClassification: 'gold',
    };
    const compiled = compileCliEvaluationInput(input);
    const calls: string[] = [];
    const observed = observePreflight(
      factoriesFor(compiled, []),
      async ({ bindingId, declaration, next }) => {
        calls.push(`${bindingId}:${declaration.preflightKind}`);
        await next();
      },
    );
    const executors = new Map(observed.executorsByImplementationId);
    for (const [implementationId, factory] of executors) {
      executors.set(implementationId, async (context) => {
        const result = await factory(context);
        return context.binding.targetId !== 'control'
          ? result
          : {
              ...result,
              preflightDeclarations: result.preflightDeclarations?.filter((candidate) => (
                candidate.preflightKind !== 'doctor'
              )),
            };
      });
    }
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: { ...observed, executorsByImplementationId: executors },
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });

    await expect(runtime.prepare()).rejects.toMatchObject({
      code: 'OMK_EVALUATION_PREFLIGHT_DECLARATION_MISSING',
      bindingId: 'executor-control',
      preflightKind: 'doctor',
    });
    expect(calls).toEqual([]);
  });

  it('redacts check failures and stops before later physical effects', async () => {
    const compiled = compositionInput();
    const calls: string[] = [];
    const factories = observePreflight(
      factoriesFor(compiled, []),
      async ({ bindingId, declaration, next }) => {
        calls.push(`${bindingId}:${declaration.preflightKind}`);
        if (
          bindingId === 'evaluator-rubric--judge-a--r0'
          && declaration.preflightKind === 'connectivity'
        ) {
          throw new Error('sensitive credential and locator detail');
        }
        await next();
      },
    );
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories,
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });

    let failure: unknown;
    try {
      await runtime.prepare();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'OMK_EVALUATION_PREFLIGHT_CHECK_FAILED',
      bindingId: 'evaluator-rubric--judge-a--r0',
      preflightKind: 'connectivity',
    });
    expect(String(failure)).not.toContain('sensitive credential');
    expect(calls).toEqual(['evaluator-rubric--judge-a--r0:connectivity']);
  });

  it('rejects non-void check results instead of treating diagnostics as evidence', async () => {
    const compiled = compositionInput();
    const base = factoriesFor(compiled, []);
    const executors = new Map(base.executorsByImplementationId);
    for (const [implementationId, factory] of executors) {
      executors.set(implementationId, async (context) => {
        const result = await factory(context);
        if (context.binding.targetId !== 'control') return result;
        return {
          ...result,
          preflightDeclarations: result.preflightDeclarations.map((candidate) => (
            candidate.preflightKind !== 'doctor'
              ? candidate
              : { ...candidate, run: () => 'sensitive diagnostic' as never }
          )),
        };
      });
    }
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: { ...base, executorsByImplementationId: executors },
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });

    await expect(runtime.prepare()).rejects.toMatchObject({
      code: 'OMK_EVALUATION_PREFLIGHT_CHECK_RESULT_INVALID',
      bindingId: 'executor-control',
      preflightKind: 'doctor',
    });
  });

  it('forwards one caller signal and waits for an in-flight preflight check to settle', async () => {
    const compiled = compositionInput();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let started = false;
    let settled = false;
    const factories = observePreflight(
      factoriesFor(compiled, []),
      async ({ bindingId, declaration, context, next }) => {
        if (bindingId !== 'executor-control' || declaration.preflightKind !== 'doctor') {
          await next();
          return;
        }
        receivedSignal = context.signal;
        started = true;
        await new Promise<void>((_resolve, reject) => {
          const onAbort = (): void => {
            settled = true;
            reject(new Error('sensitive cancellation detail'));
          };
          if (context.signal?.aborted === true) onAbort();
          else context.signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    );
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories,
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });
    const preparing = runtime.prepare({ signal: controller.signal });
    await expect.poll(() => started).toBe(true);
    expect(receivedSignal).toBe(controller.signal);
    controller.abort();

    await expect(preparing).rejects.toMatchObject({
      code: 'OMK_EVALUATION_PREFLIGHT_CANCELLED',
      bindingId: 'executor-control',
      preflightKind: 'doctor',
    });
    expect(settled).toBe(true);
  });

  it('captures declaration metadata and callback identity during binding assembly', async () => {
    const compiled = compositionInput();
    const base = factoriesFor(compiled, []);
    const executors = new Map(base.executorsByImplementationId);
    let originalCalls = 0;
    let replacementCalls = 0;
    let mutableDeclarations: OmkRuntimePreflightDeclaration[] | undefined;
    for (const [implementationId, factory] of executors) {
      executors.set(implementationId, async (context) => {
        const result = await factory(context);
        if (context.binding.targetId !== 'control') return result;
        mutableDeclarations = [...(result.preflightDeclarations ?? [])];
        const doctorIndex = mutableDeclarations.findIndex((candidate) => (
          candidate.preflightKind === 'doctor'
        ));
        mutableDeclarations[doctorIndex] = {
          preflightKind: 'doctor',
          checkId: 'captured-doctor',
          preflightDisposition: 'check',
          run() { originalCalls += 1; },
        };
        return { ...result, preflightDeclarations: mutableDeclarations };
      });
    }
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: { ...base, executorsByImplementationId: executors },
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    });
    const doctor = mutableDeclarations?.find((candidate) => (
      candidate.preflightKind === 'doctor'
    ));
    if (doctor?.preflightDisposition !== 'check') throw new Error('missing doctor declaration');
    (doctor as unknown as { run: () => void }).run = () => { replacementCalls += 1; };
    mutableDeclarations?.splice(0);

    const prepared = await runtime.prepare();
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
    expect(prepared.preflight.records).toContainEqual(expect.objectContaining({
      bindingId: 'executor-control',
      checkId: 'captured-doctor',
      preflightStatus: 'passed',
    }));
  });

  it('rejects free-form preflight identifiers at binding assembly', async () => {
    const compiled = compositionInput();
    const base = factoriesFor(compiled, []);
    const executors = new Map(base.executorsByImplementationId);
    for (const [implementationId, factory] of executors) {
      executors.set(implementationId, async (context) => {
        const result = await factory(context);
        if (context.binding.targetId !== 'control') return result;
        return {
          ...result,
          preflightDeclarations: result.preflightDeclarations.map((candidate) => (
            candidate.preflightKind !== 'doctor'
              ? candidate
              : { ...candidate, checkId: 'credential\nsecret' }
          )),
        };
      });
    }

    await expect(createOmkEvaluationRuntime({
      compiled,
      factories: { ...base, executorsByImplementationId: executors },
      support: compositionSupport(),
      resources: { leaseRoot: '/unused-test-lease-root' },
    })).rejects.toMatchObject({
      code: 'OMK_RUNTIME_BINDING_PREFLIGHT_INVALID',
      bindingId: 'executor-control',
    });
  });

  it('redacts declaration access failures at binding assembly', async () => {
    const compiled = compositionInput();
    const base = factoriesFor(compiled, []);
    const executors = new Map(base.executorsByImplementationId);
    for (const [implementationId, factory] of executors) {
      executors.set(implementationId, async (context) => {
        const result = await factory(context);
        if (context.binding.targetId !== 'control') return result;
        return Object.defineProperty({ ...result }, 'preflightDeclarations', {
          get() { throw new Error('sensitive declaration detail'); },
        });
      });
    }

    let failure: unknown;
    try {
      await createOmkEvaluationRuntime({
        compiled,
        factories: { ...base, executorsByImplementationId: executors },
        support: compositionSupport(),
        resources: { leaseRoot: '/unused-test-lease-root' },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'OMK_RUNTIME_BINDING_PREFLIGHT_INVALID',
      bindingId: 'executor-control',
    });
    expect(String(failure)).not.toContain('sensitive declaration detail');
  });

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
    await expect(prepared.start({
      runId: 'invalid-progress-options',
      progressBufferCapacity: 1,
    })).rejects.toMatchObject({
      code: 'OMK_EVALUATION_RUNTIME_INPUT_INVALID',
      fieldPath: 'progressBufferCapacity',
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

  it('isolates cancellation, events, progress and teardown across concurrent runs', async () => {
    const compiled = compositionInput({
      executionTimeout: false,
      evaluationTimeout: false,
      providerCostBudget: false,
    });
    let releaseExecution: (() => void) | undefined;
    const executeGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const lifecycle: string[] = [];
    const disposed: string[] = [];
    const controller = new AbortController();
    const progress = { isolatedA: [] as string[], isolatedB: [] as string[] };
    const closed = { isolatedA: false, isolatedB: false };
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, lifecycle, executeGate),
      support: compositionSupport(),
      resources: {
        leaseRoot: '/unused-test-lease-root',
        async materialize(request) {
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
    const first = await prepared.start({
      runId: 'isolated-a',
      signal: controller.signal,
      progressSink: {
        render(update) { progress.isolatedA.push(update.runId); },
        close() { closed.isolatedA = true; },
      },
    });
    const second = await prepared.start({
      runId: 'isolated-b',
      progressSink: {
        render(update) { progress.isolatedB.push(update.runId); },
        close() { closed.isolatedB = true; },
      },
    });
    const firstEvents: Array<{ runId: string; eventKind: string }> = [];
    const secondEvents: Array<{ runId: string; eventKind: string }> = [];
    const firstDrain = (async () => {
      for await (const event of first.events) firstEvents.push(event);
    })();
    const secondDrain = (async () => {
      for await (const event of second.events) secondEvents.push(event);
    })();

    await expect.poll(() => lifecycle.some(
      (entry) => entry.startsWith('executor.open:isolated-a:'),
    )).toBe(true);
    await expect.poll(() => lifecycle.some(
      (entry) => entry.startsWith('executor.open:isolated-b:'),
    )).toBe(true);
    controller.abort();
    releaseExecution?.();
    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
    await Promise.all([firstDrain, secondDrain]);
    await expect.poll(() => closed.isolatedA && closed.isolatedB).toBe(true);

    expect(firstResult.status).toBe('cancelled');
    expect(secondResult.status).toBe('completed');
    expect(firstEvents.length).toBeGreaterThan(0);
    expect(secondEvents.length).toBeGreaterThan(0);
    expect(firstEvents.every((event) => event.runId === 'isolated-a')).toBe(true);
    expect(secondEvents.every((event) => event.runId === 'isolated-b')).toBe(true);
    expect(firstEvents).toContainEqual(expect.objectContaining({
      eventKind: 'execution.run.cancelled',
    }));
    expect(secondEvents.some((event) => event.eventKind === 'execution.run.cancelled')).toBe(false);
    expect(secondEvents).toContainEqual(expect.objectContaining({
      eventKind: 'execution.run.completed',
    }));
    expect(secondEvents).toContainEqual(expect.objectContaining({
      eventKind: 'evaluation.run.completed',
    }));
    expect(progress.isolatedA.length).toBeGreaterThan(0);
    expect(progress.isolatedB.length).toBeGreaterThan(0);
    expect(progress.isolatedA.every((runId) => runId === 'isolated-a')).toBe(true);
    expect(progress.isolatedB.every((runId) => runId === 'isolated-b')).toBe(true);
    for (const runId of ['isolated-a', 'isolated-b']) {
      for (const runtimeKind of ['executor', 'evaluator']) {
        expect(lifecycle.filter((entry) => (
          entry.startsWith(`${runtimeKind}.run.dispose:${runId}`)
        ))).toHaveLength(lifecycle.filter((entry) => (
          entry.startsWith(`${runtimeKind}.open:${runId}:`)
        )).length);
      }
    }
    expect(disposed.sort()).toEqual(['isolated-a', 'isolated-b']);
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

  it('keeps a never-settling progress renderer outside Core result and lease cleanup', async () => {
    const compiled = compositionInput();
    let disposeCalls = 0;
    let renderCalls = 0;
    const runtime = await createOmkEvaluationRuntime({
      compiled,
      factories: runnableFactoriesFor(compiled, []),
      support: compositionSupport(),
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
    const run = await (await runtime.prepare()).start({
      runId: 'detached-progress',
      progressBufferCapacity: 1,
      progressSink: {
        render() {
          renderCalls += 1;
          return new Promise<void>(() => {});
        },
      },
    });
    const observedEvents: string[] = [];
    const drainEvents = (async () => {
      for await (const candidate of run.events) observedEvents.push(candidate.eventKind);
    })();

    await expect(run.result).resolves.toHaveProperty('status');
    await drainEvents;
    expect(renderCalls).toBe(1);
    expect(observedEvents).toContain('execution.run.started');
    expect(observedEvents.some((eventKind) => (
      eventKind.startsWith('execution.run.') && eventKind !== 'execution.run.started'
    ))).toBe(true);
    expect(disposeCalls).toBe(1);
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

  it.each([
    COMPOSITE_PARAMETERS_SCHEMA,
    COMPOSITE_TABLE_SCHEMA,
    BOOTSTRAP_FAMILY_PARAMETERS_SCHEMA,
    BOOTSTRAP_FAMILY_TABLE_SCHEMA,
    AGREEMENT_PARAMETERS_SCHEMA,
    AGREEMENT_TABLE_SCHEMA,
    RELEASE_DECISION_PARAMETERS_SCHEMA,
  ])(
    'reserves Analysis builtin SchemaValidator URI $schemaUri',
    async (schema) => {
      const compiled = compositionInput();
      const support = compositionSupport();
      const validators = new Map(support.schemaValidators);
      const conflict = {
        ...schema,
        schemaVersion: `${schema.schemaVersion}.host-conflict`,
      };
      validators.set(schemaIdentityKey(conflict), {
        schema: conflict,
        parse: (value) => value as JsonValue,
      });
      await expect(createOmkEvaluationRuntime({
        compiled,
        factories: factoriesFor(compiled, []),
        support: { ...support, schemaValidators: validators },
        resources: { leaseRoot: '/unused-test-lease-root' },
      })).rejects.toMatchObject({ code: 'OMK_EVALUATION_RUNTIME_SCHEMA_VALIDATOR_CONFLICT' });
    },
  );
});
