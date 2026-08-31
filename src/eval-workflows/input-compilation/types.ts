import type {
  AnalysisCohortDefinition,
  AnalysisGraphDefinition,
  DecisionPolicyDefinition,
  EvaluationDefinition,
  EvaluationSample,
  EvaluationSeriesDefinition,
  EvaluationSeriesMembership,
  EvaluatorDefinition,
  JsonValue,
  MeasurementPolicy,
  MetricDefinition,
  Sha256Digest,
  TargetExecutionRequirements,
} from '../../evaluation-core/contracts/index.js';

export const CLI_EVALUATION_REQUEST_SCHEMA_VERSION =
  'omk.cli-evaluation-request/v1' as const;
export const RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION =
  'omk.resolved-cli-evaluation-input/v3' as const;
export const RESOLVED_HOST_RESOURCES_SCHEMA_VERSION =
  'omk.resolved-host-resources/v2' as const;
export const RUNTIME_BINDING_REQUEST_SCHEMA_VERSION =
  'omk.runtime-binding-request/v3' as const;

export type CliEvaluationFieldSource = { readonly normalizedField: string } & (
  | {
      readonly sourceKind: 'cli-flag' | 'eval-config';
      readonly sourceKey: string;
    }
  | {
      readonly sourceKind: 'documented-default';
      readonly sourceKey: string;
      readonly defaultSource: 'documented';
    }
  | {
      readonly sourceKind: 'host-default';
      readonly sourceKey: string;
      readonly defaultSource: 'environment-selection' | 'derived';
    }
);

export interface CliEvaluationVariantRequest {
  readonly targetId: string;
  readonly experimentRole: 'control' | 'treatment';
  readonly artifactSource:
    | {
        readonly artifactSourceKind: 'expression';
        readonly expression: string;
      }
    | {
        readonly artifactSourceKind: 'remote-git';
        readonly url: string;
        readonly ref?: string;
        readonly spec: string;
      };
  readonly workspaceLocator?: string;
  readonly allowedSkills?: readonly string[];
}

export interface CliEvaluationJudgeRequest {
  readonly executorId: string;
  readonly model: string;
}

export interface CliEvaluationRequestValues {
  readonly locators: {
    readonly config?: string;
    readonly samples: string;
    readonly skillDirectory: string;
    readonly mcpConfig?: string;
    readonly gold?: string;
  };
  readonly variants: readonly CliEvaluationVariantRequest[];
  readonly targetRuntime: {
    readonly executorId: string;
    readonly model: string;
    readonly effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  readonly judges: {
    readonly enabled: boolean;
    readonly members: readonly CliEvaluationJudgeRequest[];
    readonly replicateCount: number;
    readonly lengthDebias: boolean;
  };
  readonly measurement: {
    readonly baselineIsolation: boolean;
    readonly executionConcurrency: number;
    readonly timeoutMs: number;
    readonly retryCount: number;
    readonly cache: {
      readonly executionMode: 'disabled';
      readonly evaluationMode: 'disabled';
    };
    readonly holdoutRatio?: number;
    readonly bootstrap: {
      readonly enabled: boolean;
      readonly resamples: number;
    };
    readonly decision: {
      readonly threshold?: number;
      readonly trivialDifference?: number;
    };
    readonly budget?: {
      readonly totalProviderCostUSD?: number;
      readonly perCoordinateProviderCostUSD?: number;
      readonly perCoordinateActiveDurationMs?: number;
    };
  };
  readonly orchestration: {
    readonly dryRun: boolean;
    readonly batch: boolean;
    readonly repeatCount: number;
    readonly resumeSourceLocator?: string;
    readonly preflight: {
      readonly doctor: 'required' | 'skip';
      readonly connectivity: 'required' | 'skip';
    };
    readonly diagnostic: 'enabled-outside-core' | 'disabled';
    readonly managedEvidence: 'append' | 'skip';
  };
  readonly presentation: EvaluationPresentationOptions;
}

/** Parse-stage output. Values are syntax-normalized, but locators are unresolved. */
export interface CliEvaluationRequest {
  readonly schemaVersion: typeof CLI_EVALUATION_REQUEST_SCHEMA_VERSION;
  readonly values: CliEvaluationRequestValues;
  readonly fieldSources: readonly CliEvaluationFieldSource[];
}

export type ResourceClassification = 'public' | 'sensitive' | 'secret' | 'gold';

export interface ResolvedResourceDescriptor {
  readonly resourceId: string;
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly classification: ResourceClassification;
  readonly size: number;
}

export interface ResolvedHostResource {
  readonly resourceKind:
    | 'artifact'
    | 'workspace'
    | 'mcp-config'
    | 'mock-payload'
    | 'gold-dataset'
    | 'content';
  readonly descriptor: ResolvedResourceDescriptor;
  readonly locator: string;
  readonly lineage?: JsonValue;
  readonly verification:
    | {
        readonly verificationKind: 'content-digest' | 'tree-digest';
        readonly verifiedDigest: Sha256Digest;
      }
    | {
        readonly verificationKind: 'pinned-git';
        readonly verifiedDigest: Sha256Digest;
        readonly commitId: string;
      };
}

/** Effect locators stay here and never enter Core canonical measurement JSON. */
export interface ResolvedHostResources {
  readonly schemaVersion: typeof RESOLVED_HOST_RESOURCES_SCHEMA_VERSION;
  readonly resources: readonly ResolvedHostResource[];
}

export interface ResolvedMockBinding {
  /** Samples whose Trial may observe this mock. Mock controls are never Target-global. */
  readonly sampleIds: readonly string[];
  readonly matchRules: JsonValue;
  readonly strict: boolean;
  readonly payloads: readonly ResolvedResourceDescriptor[];
}

export interface ResolvedInlineConfig {
  readonly value: JsonValue;
  readonly classification: 'public' | 'sensitive';
}

export interface ResolvedTargetBehavior {
  readonly systemInstructions: TargetExecutionRequirements['systemInstructions'];
  readonly artifact: ResolvedResourceDescriptor;
  readonly workspace?: ResolvedResourceDescriptor;
  readonly mcpConfig?: ResolvedResourceDescriptor;
  readonly mocks?: readonly ResolvedMockBinding[];
  readonly allowedTools?: readonly string[];
  readonly allowedSkills?: readonly string[];
  readonly sandbox?: {
    readonly sandboxId: string;
    readonly config?: ResolvedInlineConfig;
  };
  readonly config?: ResolvedInlineConfig;
}

export interface ResolvedCliTarget {
  readonly targetId: string;
  readonly experimentRole: 'control' | 'treatment';
  readonly targetKind: string;
  readonly protocolId: 'omk.invoke/v1' | 'omk.session/v1';
  readonly executor: {
    readonly implementationId: string;
    readonly versionConstraint?: string;
    readonly model: string;
    readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  readonly behavior: ResolvedTargetBehavior;
}

export interface ResolvedEvaluatorTemplate {
  readonly evaluatorId: string;
  readonly evaluatorKind: string;
  readonly runtimeBindingKind: 'builtin' | 'judge';
  /** Evaluator algorithm identity; judge provider identity belongs to the member runtime. */
  readonly implementationId: string;
  readonly versionConstraint?: string;
  /** Omit only when the Evaluator applies to every Dataset sample. */
  readonly applicableSampleIds?: readonly string[];
  readonly instrumentId: string;
  /** Provider prompt/instrument variant owned by this Evaluator family. */
  readonly runtimePromptVariant?: string;
  readonly replicateGroupId: string;
  readonly metricIds: readonly string[];
  readonly inputs: readonly EvaluatorDefinition['inputs'][number][];
  readonly config?: ResolvedInlineConfig;
  readonly resources?: readonly ResolvedResourceDescriptor[];
}

export interface ResolvedJudgeMember {
  readonly ensembleMemberId: string;
  readonly executorId: string;
  readonly model: string;
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface ResolvedIndependentSeriesInput {
  readonly repeatCount: number;
  /** Host-allocated identity for one independent Series execution. */
  readonly seriesInstanceId: string;
  readonly comparisonScope?: 'evaluation' | 'analysis' | 'decision';
  readonly minimumStatus?: 'compatible' | 'conditional';
}

export interface ResolvedEvaluationOrchestrationInput {
  readonly dryRun: boolean;
  readonly batch: boolean;
  readonly resumeSourceLocator?: string;
  readonly preflight: {
    readonly doctor: 'required' | 'skip';
    readonly connectivity: 'required' | 'skip';
  };
  readonly diagnostic: 'enabled-outside-core' | 'disabled';
  readonly managedEvidence: 'append' | 'skip';
  /** Normalized sample-bundle readiness requirements for the host doctor phase. */
  readonly dependencyRequirements?: {
    /** Host-only base for relative files and preflight commands. */
    readonly baseDirectoryLocator: string;
    readonly tools?: readonly string[];
    readonly files?: readonly string[];
    readonly env?: readonly string[];
    readonly preflight?: readonly string[];
  };
  /** Effect locators used to assemble cache ports; never enter Core canonical JSON. */
  readonly cacheSources?: {
    readonly executionSourceLocator?: string;
    readonly evaluationSourceLocator?: string;
  };
  readonly gold?: {
    readonly resourceId: string;
    readonly comparisonMode: 'exploratory-post-hoc';
  };
  readonly independentSeries?: ResolvedIndependentSeriesInput;
}

export interface EvaluationPresentationOptions {
  readonly outputDirectoryLocator: string;
  readonly indexScope: 'project' | 'global';
  readonly language: 'zh' | 'en';
  readonly serve: boolean;
  readonly verbose: boolean;
  readonly layeredView: boolean;
  readonly exitMode: 'gate' | 'report-only';
}

export interface ResolvedMeasurementPolicyInput {
  readonly executionConcurrency: number;
  readonly evaluationConcurrency?: number;
  readonly executionTimeoutMs?: number;
  readonly evaluationTimeoutMs?: number;
  /** Infrastructure retries after the first attempt. */
  readonly retryCount: number;
  readonly retryableErrorCodes?: readonly string[];
  readonly cache: {
    readonly executionMode: MeasurementPolicy['cache']['executionMode'];
    readonly evaluationMode: MeasurementPolicy['cache']['evaluationMode'];
  };
  readonly budget?: {
    readonly totalProviderCostUSD?: number;
    readonly perCoordinateProviderCostUSD?: number;
    readonly perCoordinateActiveDurationMs?: number;
    readonly runMaxInvocations?: number;
    readonly executionMaxInvocations?: number;
    readonly evaluationMaxInvocations?: number;
  };
  readonly evidence?: MeasurementPolicy['evidence'];
  readonly failure?: MeasurementPolicy['failure'];
  readonly eventDelivery?: MeasurementPolicy['eventDelivery'];
}

export interface ResolvedCliEvaluationInput {
  readonly schemaVersion: typeof RESOLVED_CLI_EVALUATION_INPUT_SCHEMA_VERSION;
  readonly dataset: {
    readonly datasetId: string;
    readonly samples: readonly EvaluationSample[];
    readonly analysisCohorts?: readonly AnalysisCohortDefinition[];
  };
  readonly targets: readonly ResolvedCliTarget[];
  readonly evaluatorTemplates: readonly ResolvedEvaluatorTemplate[];
  readonly judges: {
    readonly enabled: boolean;
    readonly members: readonly ResolvedJudgeMember[];
    readonly replicateCount: number;
  };
  readonly metrics: readonly MetricDefinition[];
  readonly experiment: Omit<EvaluationDefinition['experiment'], 'randomizationSlots'>;
  readonly analysisGraph: AnalysisGraphDefinition;
  readonly decisionPolicy?: DecisionPolicyDefinition;
  readonly policy: ResolvedMeasurementPolicyInput;
  readonly hostResources: ResolvedHostResources;
  readonly orchestration: ResolvedEvaluationOrchestrationInput;
  readonly presentation: EvaluationPresentationOptions;
  readonly staticRunMetadata?: {
    readonly annotations?: JsonValue;
    readonly summaries?: JsonValue;
  };
}

export interface RuntimeResourceLeaseRequirement {
  readonly resourceId: string;
  readonly resourceRole: 'artifact' | 'workspace' | 'mcp-config' | 'mock-payload' | 'content';
  readonly leaseMode: 'immutable-snapshot' | 'copy-on-write-overlay';
}

export type AnalysisRuntimeBinding =
  | {
      readonly runtimeKind: 'analysis-node';
      readonly bindingId: string;
      readonly referenceId: string;
      readonly requirementKind: 'analysis-node';
      readonly analysisNodeKind: 'reducer' | 'estimator' | 'correction';
      readonly implementationId: string;
      readonly versionConstraint?: string;
    }
  | {
      readonly runtimeKind: 'analysis-node';
      readonly bindingId: string;
      readonly referenceId: string;
      readonly requirementKind: 'sampling-estimator';
      readonly analysisNodeKind: 'estimator';
      readonly implementationId: string;
      readonly versionConstraint?: string;
    };

export type RuntimeBinding =
  | {
      readonly runtimeKind: 'executor';
      readonly bindingId: string;
      readonly targetId: string;
      readonly implementationId: string;
      readonly versionConstraint?: string;
      readonly protocolId: ResolvedCliTarget['protocolId'];
      readonly behaviorConfigDigest: Sha256Digest;
      readonly resourceLeaseRequirements: readonly RuntimeResourceLeaseRequirement[];
      readonly qualification: {
        readonly model: string;
        readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
        readonly executionRequirements: TargetExecutionRequirements;
        readonly resourceIntegrity: 'digest-before-use';
      };
    }
  | {
      readonly runtimeKind: 'evaluator';
      readonly bindingId: string;
      readonly evaluatorId: string;
      readonly implementationId: string;
      readonly versionConstraint?: string;
      readonly measurement: EvaluatorDefinition['measurement'];
      readonly configDigest?: Sha256Digest;
      readonly resourceLeaseRequirements: readonly RuntimeResourceLeaseRequirement[];
      readonly qualification?: {
        readonly executorId: string;
        readonly model: string;
        readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
        readonly promptVariant: string;
        readonly resourceIntegrity: 'digest-before-use';
      };
    }
  | AnalysisRuntimeBinding
  | {
      readonly runtimeKind: 'missing-policy';
      readonly bindingId: string;
      readonly policyId: string;
      readonly implementationId: string;
    }
  | {
      readonly runtimeKind: 'decision-policy';
      readonly bindingId: string;
      readonly decisionPolicyId: string;
      readonly implementationId: string;
      readonly versionConstraint?: string;
    }
  | {
      readonly runtimeKind: 'series-analysis-node';
      readonly bindingId: string;
      readonly nodeId: string;
      readonly implementationId: string;
    }
  | {
      readonly runtimeKind: 'series-decision-policy';
      readonly bindingId: string;
      readonly decisionPolicyId: string;
      readonly implementationId: string;
    };

export interface RuntimeBindingRequest {
  readonly schemaVersion: typeof RUNTIME_BINDING_REQUEST_SCHEMA_VERSION;
  readonly bindings: readonly RuntimeBinding[];
}

export interface CompiledIndependentSeries {
  readonly definition: EvaluationSeriesDefinition;
  readonly memberships: readonly EvaluationSeriesMembership[];
}

export interface EvaluationOrchestrationOptions
  extends Omit<ResolvedEvaluationOrchestrationInput, 'independentSeries'> {
  readonly independentSeries?: CompiledIndependentSeries;
}

export interface StaticEvaluationRunOptions {
  readonly metadata?: {
    readonly annotations?: JsonValue;
    readonly summaries?: JsonValue;
  };
}

export interface CliEvaluationCompileResult {
  readonly definition: EvaluationDefinition;
  readonly policy: MeasurementPolicy;
  readonly runtimeBinding: RuntimeBindingRequest;
  readonly hostResources: ResolvedHostResources;
  readonly orchestration: EvaluationOrchestrationOptions;
  readonly presentation: EvaluationPresentationOptions;
  readonly runOptions: StaticEvaluationRunOptions;
  readonly canonicalDigests: {
    readonly definition: Sha256Digest;
    readonly policy: Sha256Digest;
  };
}
