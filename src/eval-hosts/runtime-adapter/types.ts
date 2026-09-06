import type {
  EvaluationDefinition,
  EvaluationSeriesDefinition,
  RuntimeIdentity,
} from '../../eval-core/contracts/index.js';
import type {
  AnalysisRuntimeRequirement,
  RuntimeResolution,
} from '../../eval-core/compiler/index.js';
import type {
  AnalysisDecisionPolicy,
  AnalysisMissingPolicy,
  AnalysisNodeImplementation,
} from '../../eval-core/analysis/index.js';
import type { EvaluationEngineRuntimeBindings } from '../../eval-core/engine/index.js';
import type { EvaluationEvaluator } from '../../eval-core/evaluation/index.js';
import type { ExecutionExecutor } from '../../eval-core/execution/index.js';
import type {
  EvaluationSeriesRuntimePorts,
  SeriesAnalysisNodeRuntime,
  SeriesDecisionRuntime,
} from '../../eval-core/series/index.js';
import type {
  RuntimeBinding,
  RuntimeBindingRequest,
  RuntimeResourceLeaseRequirement,
} from '../../eval-workflows/input-compilation/index.js';
import type {
  OmkBindingResourceLeaseAccess,
  OmkRunResourceLeaseRegistry,
} from './resource-leases/types.js';

export type RuntimeBindingOf<RuntimeKind extends RuntimeBinding['runtimeKind']> = Extract<
  RuntimeBinding,
  { runtimeKind: RuntimeKind }
>;

export type OmkRuntimePreflightKind =
  | 'doctor'
  | 'credential'
  | 'connectivity'
  | 'filesystem'
  | 'mcp-readiness'
  | 'mock-readiness';

export interface OmkRuntimePreflightContext {
  readonly runtimeKind: RuntimeBinding['runtimeKind'];
  readonly bindingId: string;
  readonly referenceId: string;
  readonly implementationId: string;
  /** Caller-owned cancellation; checks must settle their effects before returning. */
  readonly signal?: AbortSignal;
}

interface OmkRuntimePreflightDeclarationBase {
  readonly preflightKind: OmkRuntimePreflightKind;
  readonly checkId: string;
}

export interface OmkRuntimePreflightCheck
  extends OmkRuntimePreflightDeclarationBase {
  readonly preflightDisposition: 'check';
  readonly run: (
    context: Readonly<OmkRuntimePreflightContext>,
  ) => void | Promise<void>;
}

export interface OmkRuntimePreflightNotRequired
  extends OmkRuntimePreflightDeclarationBase {
  readonly preflightDisposition: 'not-required';
  /** Stable, non-sensitive adapter-owned reason; this is not free-form diagnostic text. */
  readonly reasonCode: string;
}

export type OmkRuntimePreflightDeclaration =
  | OmkRuntimePreflightCheck
  | OmkRuntimePreflightNotRequired;

type AnalysisRuntimeBindingOf<RequirementKind extends 'analysis-node' | 'sampling-estimator'> =
  Extract<RuntimeBinding, {
    runtimeKind: 'analysis-node';
    requirementKind: RequirementKind;
  }>;

export interface OmkRuntimePortBinding<Port> {
  readonly port: Port;
  /** Resolved by the implementation that owns the actual Runtime version. */
  readonly satisfiesVersionConstraint: boolean;
  /** Binding-owned physical checks; use an explicit empty array when none apply. */
  readonly preflightDeclarations: readonly OmkRuntimePreflightDeclaration[];
}

interface OmkBindingFactoryContext {
  /** Binding-local scope to combine with Core runId and trialId. */
  readonly sessionIsolationKey: string;
}

export interface OmkExecutorBindingContext extends OmkBindingFactoryContext {
  readonly binding: RuntimeBindingOf<'executor'>;
  readonly target: EvaluationDefinition['targets'][number];
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
}

export interface OmkEvaluatorBindingContext extends OmkBindingFactoryContext {
  readonly binding: RuntimeBindingOf<'evaluator'>;
  readonly evaluator: EvaluationDefinition['evaluators'][number];
  readonly resourceLeases: OmkBindingResourceLeaseAccess;
}

export type OmkAnalysisNodeBindingContext =
  | {
      readonly sessionIsolationKey: string;
      readonly binding: AnalysisRuntimeBindingOf<'analysis-node'>;
      readonly requirement: Extract<AnalysisRuntimeRequirement, {
        requirementKind: 'analysis-node';
      }>;
      readonly subject: EvaluationDefinition['analysisGraph']['nodes'][number];
    }
  | {
      readonly sessionIsolationKey: string;
      readonly binding: AnalysisRuntimeBindingOf<'sampling-estimator'>;
      readonly requirement: Extract<AnalysisRuntimeRequirement, {
        requirementKind: 'sampling-estimator';
      }>;
      readonly subject: EvaluationDefinition['experiment']['sampling'];
    };

export interface OmkMissingPolicyBindingContext extends OmkBindingFactoryContext {
  readonly binding: RuntimeBindingOf<'missing-policy'>;
  readonly metricIds: readonly string[];
}

export interface OmkDecisionPolicyBindingContext extends OmkBindingFactoryContext {
  readonly binding: RuntimeBindingOf<'decision-policy'>;
  readonly policy: NonNullable<EvaluationDefinition['decisionPolicy']>;
}

export interface OmkSeriesAnalysisNodeBindingContext extends OmkBindingFactoryContext {
  readonly binding: RuntimeBindingOf<'series-analysis-node'>;
  readonly node: EvaluationSeriesDefinition['analysisGraph']['nodes'][number];
}

export interface OmkSeriesDecisionPolicyBindingContext extends OmkBindingFactoryContext {
  readonly binding: RuntimeBindingOf<'series-decision-policy'>;
  readonly policy: NonNullable<EvaluationSeriesDefinition['decisionPolicy']>;
}

type Factory<Context, Port> = (
  context: Readonly<Context>,
) => OmkRuntimePortBinding<Port> | Promise<OmkRuntimePortBinding<Port>>;

export interface OmkRuntimeBindingFactories {
  readonly executorsByImplementationId: ReadonlyMap<
    string,
    Factory<OmkExecutorBindingContext, ExecutionExecutor>
  >;
  readonly evaluatorsByImplementationId: ReadonlyMap<
    string,
    Factory<OmkEvaluatorBindingContext, EvaluationEvaluator>
  >;
  readonly analysisNodesByImplementationId: ReadonlyMap<
    string,
    Factory<OmkAnalysisNodeBindingContext, AnalysisNodeImplementation>
  >;
  readonly missingPoliciesByImplementationId: ReadonlyMap<
    string,
    Factory<OmkMissingPolicyBindingContext, AnalysisMissingPolicy>
  >;
  readonly decisionPoliciesByImplementationId: ReadonlyMap<
    string,
    Factory<OmkDecisionPolicyBindingContext, AnalysisDecisionPolicy>
  >;
  readonly seriesAnalysisNodesByImplementationId: ReadonlyMap<
    string,
    Factory<OmkSeriesAnalysisNodeBindingContext, SeriesAnalysisNodeRuntime>
  >;
  readonly seriesDecisionPoliciesByImplementationId: ReadonlyMap<
    string,
    Factory<OmkSeriesDecisionPolicyBindingContext, SeriesDecisionRuntime>
  >;
}

interface OmkRuntimeBindingEntryBase<
  RuntimeKind extends RuntimeBinding['runtimeKind'],
  Port,
> {
  readonly runtimeKind: RuntimeKind;
  readonly referenceId: string;
  readonly binding: RuntimeBindingOf<RuntimeKind>;
  readonly resolution: RuntimeResolution;
  readonly port: Port;
  /** Resources that must be acquired before this binding may open a run. */
  readonly resourceLeaseRequirements: readonly RuntimeResourceLeaseRequirement[];
  /** Binding-local session scope; adapters combine it with Core's runId and trialId. */
  readonly sessionIsolationKey: string;
  /** Captured together with the port and Runtime identity from the same factory result. */
  readonly preflightDeclarations: readonly OmkRuntimePreflightDeclaration[];
}

export type OmkEvaluationRuntimeBindingEntry =
  | OmkRuntimeBindingEntryBase<'executor', ExecutionExecutor>
  | OmkRuntimeBindingEntryBase<'evaluator', EvaluationEvaluator>
  | OmkRuntimeBindingEntryBase<'analysis-node', AnalysisNodeImplementation>
  | OmkRuntimeBindingEntryBase<'missing-policy', AnalysisMissingPolicy>
  | OmkRuntimeBindingEntryBase<'decision-policy', AnalysisDecisionPolicy>;

export type OmkEvaluationSeriesRuntimeBindingEntry =
  | OmkRuntimeBindingEntryBase<'series-analysis-node', SeriesAnalysisNodeRuntime>
  | OmkRuntimeBindingEntryBase<'series-decision-policy', SeriesDecisionRuntime>;

export interface OmkEvaluationRuntimeBindingAssembly {
  readonly entries: readonly OmkEvaluationRuntimeBindingEntry[];
  readonly bindings: EvaluationEngineRuntimeBindings;
  readonly resourceLeaseRegistry: OmkRunResourceLeaseRegistry;
}

export interface OmkEvaluationSeriesRuntimeBindingAssembly {
  readonly entries: readonly OmkEvaluationSeriesRuntimeBindingEntry[];
  readonly runtimes: readonly (
    | {
        readonly runtimeKind: 'series-analysis-node';
        readonly referenceId: string;
        readonly identity: RuntimeIdentity;
        readonly outputSchema: SeriesAnalysisNodeRuntime['outputSchema'];
      }
    | {
        readonly runtimeKind: 'series-decision-policy';
        readonly referenceId: string;
        readonly identity: RuntimeIdentity;
      }
  )[];
  readonly ports: Pick<
    EvaluationSeriesRuntimePorts,
    'analysisNodesByNodeId' | 'decisionPoliciesByDecisionPolicyId'
  >;
}

export interface OmkRuntimeBindingAssembly {
  readonly evaluation: OmkEvaluationRuntimeBindingAssembly;
  readonly series?: OmkEvaluationSeriesRuntimeBindingAssembly;
}

export interface AssembleOmkRuntimeBindingsInput {
  readonly definition: EvaluationDefinition;
  readonly runtimeBinding: RuntimeBindingRequest;
  readonly factories: OmkRuntimeBindingFactories;
  readonly seriesDefinition?: EvaluationSeriesDefinition;
}

export type OmkRuntimeAssemblyErrorCode =
  | 'OMK_RUNTIME_ASSEMBLY_INPUT_INVALID'
  | 'OMK_RUNTIME_BINDING_REQUEST_INVALID'
  | 'OMK_RUNTIME_BINDING_DUPLICATE'
  | 'OMK_RUNTIME_BINDING_COVERAGE_MISMATCH'
  | 'OMK_RUNTIME_BINDING_DEFINITION_MISMATCH'
  | 'OMK_RUNTIME_BINDING_FACTORY_MISSING'
  | 'OMK_RUNTIME_BINDING_FACTORY_FAILED'
  | 'OMK_RUNTIME_BINDING_PORT_INVALID'
  | 'OMK_RUNTIME_BINDING_PREFLIGHT_INVALID';

export class OmkRuntimeAssemblyError extends TypeError {
  readonly code: OmkRuntimeAssemblyErrorCode;
  readonly bindingId?: string;
  readonly referenceId?: string;

  constructor(input: {
    code: OmkRuntimeAssemblyErrorCode;
    message: string;
    bindingId?: string;
    referenceId?: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'OmkRuntimeAssemblyError';
    this.code = input.code;
    this.bindingId = input.bindingId;
    this.referenceId = input.referenceId;
  }
}
