import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  MEASUREMENT_POLICY_SCHEMA_VERSION,
  digestCanonicalJson,
  type EvaluationDefinition,
  type MeasurementPolicy,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../../../src/evaluation-core/contracts/index.js';
import type {
  AnalysisRuntimeRequirement,
  ExtensionValidationRequest,
  PreparationRuntime,
} from '../../../src/evaluation-core/compiler/index.js';

function schemaIdentity(name: string): SchemaIdentity {
  return {
    schemaVersion: `example.${name}/v1`,
    schemaUri: `urn:example:schema:${name}:v1`,
    schemaDigest: digestCanonicalJson({ name, version: 1 }),
  };
}

function identity(
  implementationId: string,
  fingerprint: string,
  capabilities: RuntimeIdentity['capabilities'],
  assuranceLevel: RuntimeIdentity['assuranceLevel'] = 'verified',
): RuntimeIdentity {
  return {
    implementationId,
    version: '1.0.0',
    fingerprint,
    fingerprintBasis: 'content-derived',
    assuranceLevel,
    capabilities,
  };
}

export function validDefinition(): EvaluationDefinition {
  return {
    schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
    dataset: {
      datasetId: 'dataset-1',
      samples: [{
        sampleId: 'sample-1',
        input: { question: 'Q', cohort: 'a' },
        executionContext: { locale: 'zh-CN' },
        expected: { answer: 'A' },
        evaluationContext: { rubric: 'correctness' },
        annotations: { owner: 'team-a' },
      }],
      annotations: { project: 'omk' },
    },
    targets: [
      {
        targetId: 'control',
        targetKind: 'function',
        protocolId: 'omk.invoke/v1',
        executorId: 'executor-alias',
        versionConstraint: '^1.0.0',
      },
      {
        targetId: 'treatment',
        targetKind: 'agent',
        protocolId: 'omk.invoke/v1',
        executorId: 'executor-alias',
        versionConstraint: '^1.0.0',
      },
    ],
    evaluators: [{
      evaluatorId: 'exact',
      evaluatorKind: 'assertion',
      implementationId: 'exact/v1',
      versionConstraint: '^1.0.0',
      metricIds: ['correct'],
      inputs: [
        { bindingId: 'actual', sourceKind: 'output', pointer: '/answer' },
        { bindingId: 'gold', sourceKind: 'expected', pointer: '/answer' },
      ],
    }],
    metrics: [{
      metricId: 'correct',
      valueType: 'boolean',
      scope: 'sample',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    }],
    experiment: {
      trials: 1,
      seed: 'seed-1',
      sampling: {
        experimentalUnit: 'sample',
        repeatedMeasures: false,
        resamplingUnit: 'sample',
        estimatorId: 'bootstrap.mean-percentile/v1',
        seedCoupling: 'independent-by-target',
      },
      scheduling: { schedulingKind: 'interleaved' },
    },
    analysisGraph: {
      analysisMode: 'preregistered',
      nodes: [{
        analysisNodeKind: 'reducer',
        nodeId: 'mean-correct',
        implementationId: 'descriptive.rate/v1',
        inputs: [{ inputKind: 'metric-observations', referenceId: 'correct' }],
        outputResultId: 'correct-rate',
        parameters: { minimumCoverage: 0.8 },
      }],
    },
    comparisons: [{
      comparisonId: 'control-vs-treatment',
      controlTargetId: 'control',
      treatmentTargetIds: ['treatment'],
      metricIds: ['correct'],
    }],
    decisionPolicy: {
      decisionPolicyId: 'release-gate',
      implementationId: 'progress/v1',
      analysisResultIds: ['correct-rate'],
      minimumEvidenceStatus: 'complete',
      parameters: { threshold: 0 },
    },
  };
}

export function validPolicy(): MeasurementPolicy {
  return {
    schemaVersion: MEASUREMENT_POLICY_SCHEMA_VERSION,
    execution: { maxConcurrency: 2, timeoutMs: 10_000 },
    retry: {
      maxAttempts: 2,
      retryableErrorCodes: ['timeout'],
      backoff: {
        backoffKind: 'exponential',
        initialDelayMs: 10,
        maxDelayMs: 100,
      },
    },
    budget: { maxTargetInvocations: 100 },
    evaluation: {
      maxConcurrency: 2,
      timeoutMs: 10_000,
      retry: {
        maxAttempts: 2,
        retryableErrorCodes: ['timeout'],
        backoff: {
          backoffKind: 'exponential',
          initialDelayMs: 10,
          maxDelayMs: 100,
        },
      },
      budget: { maxEvaluatorInvocations: 100 },
    },
    cache: { executionMode: 'disabled', evaluationMode: 'disabled' },
    evidence: {
      input: 'digest',
      output: 'full',
      trace: 'reference',
      expected: 'digest',
      evidence: 'full',
      maximumClassification: 'gold',
    },
    failure: { failureMode: 'continue' },
    eventDelivery: {
      writerMode: 'disabled',
      backpressureMode: 'block',
      writerFailureMode: 'ignore',
    },
  };
}

interface RuntimeOptions {
  executorFingerprint?: string;
  deterministic?: boolean;
  executorAssurance?: RuntimeIdentity['assuranceLevel'];
  cancellation?: 'cooperative' | 'best-effort' | 'unsupported';
  trialState?: 'stateless' | 'isolated';
  traceCapability?: 'unsupported' | 'optional' | 'required';
  seedControl?: 'unsupported' | 'optional' | 'required';
  concurrencySafety?: 'serialized' | 'parallel-safe';
  maxInFlight?: number;
  executorProtocols?: Array<'omk.invoke/v1' | 'omk.session/v1'>;
  evaluatorValueTypes?: Array<'numeric' | 'boolean' | 'categorical' | 'text' | 'ranking'>;
  analysisValueTypes?: Array<'numeric' | 'boolean' | 'categorical' | 'text' | 'ranking'>;
  samplingResamplingUnits?: Array<'sample' | 'paired-block' | 'cluster' | 'run'>;
  versionSatisfied?: boolean;
  throwExecutor?: boolean;
  extensionStages?: Record<string, 'execution' | 'evaluation' | 'analysis' | 'decision' | 'run' | 'audit'>;
  rejectExtension?: string;
}

export interface TestRuntime extends PreparationRuntime {
  calls: {
    executor: number;
    evaluator: number;
    analysis: number;
    extension: number;
  };
  returnedIdentities: RuntimeIdentity[];
}

export function testRuntime(options: RuntimeOptions = {}): TestRuntime {
  const calls = { executor: 0, evaluator: 0, analysis: 0, extension: 0 };
  const returnedIdentities: RuntimeIdentity[] = [];
  const remember = (value: RuntimeIdentity): RuntimeIdentity => {
    returnedIdentities.push(value);
    return value;
  };
  return {
    calls,
    returnedIdentities,
    resolveExecutor(requirement) {
      calls.executor += 1;
      if (options.throwExecutor) throw new Error('secret provider response');
      if (!Object.isFrozen(requirement)) throw new Error('requirement is mutable');
      const protocols = options.executorProtocols ?? ['omk.invoke/v1'];
      return {
        identity: remember(identity(
          'actual-executor/v1',
          options.executorFingerprint ?? 'executor-fingerprint-1',
          {
            protocols: protocols.map((protocolId) => ({
              protocolId,
              inputSchema: schemaIdentity(`${protocolId}:input`),
              outputSchema: schemaIdentity(`${protocolId}:output`),
              ...((options.traceCapability ?? 'unsupported') !== 'unsupported'
                ? { traceSchema: schemaIdentity(`${protocolId}:trace`) }
                : {}),
              execution: {
                concurrency: {
                  safety: options.concurrencySafety ?? 'parallel-safe',
                  ...(options.maxInFlight !== undefined
                    ? { maxInFlight: options.maxInFlight }
                    : {}),
                },
                cancellation: options.cancellation ?? 'cooperative',
                state: {
                  resourceLifecycle: 'per-run',
                  trialState: options.trialState
                    ?? (protocolId === 'omk.session/v1' ? 'isolated' : 'stateless'),
                },
                seedControl: options.seedControl ?? 'optional',
                determinism: (options.deterministic ?? true)
                  ? 'deterministic'
                  : 'stochastic',
                telemetry: {
                  trace: options.traceCapability ?? 'unsupported',
                  usage: 'optional',
                },
              },
            })),
          },
          options.executorAssurance,
        )),
        satisfiesVersionConstraint: options.versionSatisfied ?? true,
      };
    },
    resolveEvaluator(requirement) {
      calls.evaluator += 1;
      if (!Object.isFrozen(requirement)) throw new Error('requirement is mutable');
      return {
        identity: remember(identity('actual-evaluator/v1', 'evaluator-fingerprint-1', {
          inputSourceKinds: ['output', 'trace', 'expected', 'evaluation-context'],
          metricValueTypes: options.evaluatorValueTypes ?? ['boolean'],
          schemas: [schemaIdentity('evaluator-io')],
        })),
        satisfiesVersionConstraint: options.versionSatisfied ?? true,
      };
    },
    resolveAnalysis(requirement: Readonly<AnalysisRuntimeRequirement>) {
      calls.analysis += 1;
      if (!Object.isFrozen(requirement)) throw new Error('requirement is mutable');
      if (requirement.requirementKind === 'missing-policy') {
        return {
          identity: remember(identity(
            'exclude/v1',
            'missing-policy-fingerprint-1',
            {
              capabilityKind: 'missing-policy',
              valueTypes: ['numeric', 'boolean', 'categorical', 'text', 'ranking'],
              schemas: [],
            },
          )),
          satisfiesVersionConstraint: options.versionSatisfied ?? true,
        };
      }
      if (requirement.requirementKind === 'decision-policy') {
        return {
          identity: remember(identity(
            'progress/v1',
            'decision-policy-fingerprint-1',
            {
              capabilityKind: 'decision-policy',
              analysisResultSchemaUris: [schemaIdentity('analysis-output').schemaUri],
              multipleComparisonPolicyIds: ['bonferroni/v1'],
              schemas: [],
            },
          )),
          satisfiesVersionConstraint: options.versionSatisfied ?? true,
        };
      }
      const isSampling = requirement.requirementKind === 'sampling-estimator';
      return {
        identity: remember(identity(
          `actual-${isSampling ? 'estimator' : 'analysis'}/v1`,
          `${isSampling ? 'estimator' : 'analysis'}-fingerprint-1`,
          {
            capabilityKind: 'analysis-node',
            analysisNodeKinds: [isSampling ? 'estimator' : requirement.analysisNodeKind],
            inputDomains: isSampling ? [] : [{
              inputKind: 'metric-observations',
              valueTypes: options.analysisValueTypes ?? ['boolean'],
              missingPolicyIds: ['exclude/v1'],
            }],
            outputSchema: schemaIdentity(isSampling ? 'estimator-output' : 'analysis-output'),
            ...(!isSampling ? { metricInputCardinality: { min: 1, max: 1 } } : {}),
            ...(isSampling ? {
              sampling: {
                experimentalUnits: ['sample'],
                repeatedMeasures: [false],
                resamplingUnits: options.samplingResamplingUnits ?? ['sample'],
              },
            } : {}),
            schemas: [],
          },
        )),
        satisfiesVersionConstraint: options.versionSatisfied ?? true,
      };
    },
    validateExtension(request: Readonly<ExtensionValidationRequest>) {
      calls.extension += 1;
      if (!Object.isFrozen(request) || !Object.isFrozen(request.entry)) {
        throw new Error('extension request is mutable');
      }
      if (options.rejectExtension === request.namespace) throw new Error('invalid extension');
      const impactStage = options.extensionStages?.[request.namespace];
      return impactStage === undefined ? {} : { impactStage };
    },
  };
}
