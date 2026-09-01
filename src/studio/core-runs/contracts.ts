import type {
  AnalysisObservationCoverage,
  AnalysisCoverage,
  BudgetTermination,
  EvaluationStatus,
  ExecutionCoverage,
  EvaluationCoverage,
} from '../../evaluation-core/contracts/index.js';

export const CORE_STUDIO_RUN_CARD_SCHEMA_VERSION =
  'omk.studio-core-run-card/v1' as const;
export const CORE_STUDIO_RUN_DETAIL_SCHEMA_VERSION =
  'omk.studio-core-run-detail/v1' as const;

export interface CoreStudioRunCard {
  readonly cardKind: 'studio-core-run-card';
  readonly schemaVersion: typeof CORE_STUDIO_RUN_CARD_SCHEMA_VERSION;
  readonly runId: string;
  readonly reportId: string;
  readonly runContractDigest: string;
  readonly reportDigest: string;
  readonly artifactSetDigest: string;
  readonly createdAt: string;
  readonly status: EvaluationStatus;
  readonly replayability: {
    readonly execution: 'self-contained' | 'resolvable' | 'summary-only';
    readonly evaluation: 'self-contained' | 'resolvable' | 'summary-only';
  };
  readonly maximumCapturedClassification: 'public' | 'sensitive' | 'secret' | 'gold';
}

export interface CoreStudioRuntimeIdentity {
  readonly implementationId: string;
  readonly version?: string;
  readonly fingerprint: string;
  readonly fingerprintBasis: 'content-derived' | 'environment-derived' | 'self-reported' | 'opaque';
  readonly assuranceLevel: 'verified' | 'declared' | 'unknown';
}

export interface CoreStudioProvenance {
  readonly provenanceKind: 'native' | 'imported' | 'replay' | 'derived';
  readonly trust: 'verified' | 'declared' | 'untrusted' | 'unknown';
  readonly parentDigests: readonly string[];
}

export interface CoreStudioUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly providerCost?: {
    readonly amount: number;
    readonly currency: string;
  };
}

export interface CoreStudioBudget {
  readonly summaryStatus: 'within-budget' | 'exhausted' | 'unverifiable' | 'cancelled' | 'failed';
  readonly admissionMode: 'strict-reservation' | 'bounded-overshoot';
  readonly invocations: number;
  readonly activeDurationMs: number;
  readonly reportedProviderCosts: readonly {
    readonly amount: number;
    readonly currency: string;
  }[];
  readonly unreportedProviderCostInvocations: number;
  readonly wallClock: {
    readonly elapsedMs: number;
    readonly limitMs?: number;
    readonly overshootMs: number;
  };
  readonly termination?: {
    readonly terminationKind: BudgetTermination['terminationKind'];
    readonly resourceKind?: BudgetTermination['resourceKind'];
    readonly scopeKind?: BudgetTermination['scopeKind'];
    readonly reasonCode: string;
  };
  readonly ledgerDigest: string;
}

export interface CoreStudioExecutionRecord {
  readonly targetId: string;
  readonly sampleId: string;
  readonly trialIndex: number;
  readonly trialId: string;
  readonly executionStatus: 'completed' | 'failed' | 'cancelled' | 'budget-censored';
  readonly runtime: CoreStudioRuntimeIdentity;
  readonly provenance: CoreStudioProvenance;
  readonly cacheStatus?: 'not-used' | 'miss' | 'replay' | 'transparent-hit';
  readonly durationMs?: number;
  readonly usage?: CoreStudioUsage;
  readonly errorCode?: string;
  readonly censorReasonCode?: string;
}

export interface CoreStudioMetricObservation {
  readonly observationId: string;
  readonly metricId: string;
  readonly observationStatus: 'observed' | 'missing' | 'invalid';
  readonly valueType: 'numeric' | 'boolean' | 'categorical' | 'text' | 'ranking';
  readonly numericValue?: number;
  readonly reasonCode?: string;
}

export interface CoreStudioEvaluationRecord {
  readonly targetId: string;
  readonly sampleId: string;
  readonly trialIndex: number;
  readonly trialId: string;
  readonly evaluatorId: string;
  readonly measurement: {
    readonly instrumentId: string;
    readonly ensembleMemberId: string;
    readonly replicateGroupId: string;
    readonly replicateIndex: number;
  };
  readonly evaluationId: string;
  readonly evaluationStatus: 'completed' | 'failed' | 'cancelled' | 'not-evaluated';
  readonly runtime: CoreStudioRuntimeIdentity;
  readonly provenance: CoreStudioProvenance;
  readonly cacheStatus?: 'not-used' | 'miss' | 'replay' | 'transparent-hit';
  readonly durationMs?: number;
  readonly usage?: CoreStudioUsage;
  readonly observations: readonly CoreStudioMetricObservation[];
  readonly errorCode?: string;
  readonly notEvaluatedReasonCode?: string;
}

export type CoreStudioAnalysisRecord = {
  readonly resultId: string;
  readonly nodeId: string;
  readonly analysisNodeKind: 'reducer' | 'estimator' | 'correction';
  readonly analysisStatus: 'completed' | 'inconclusive' | 'failed' | 'not-evaluated';
  readonly analysisMode: 'preregistered' | 'exploratory';
  readonly runtime: CoreStudioRuntimeIdentity;
  readonly outputSchema: {
    readonly schemaVersion: string;
    readonly schemaDigest: string;
  };
  readonly coverage: AnalysisObservationCoverage;
  readonly exclusionCount: number;
  readonly assumptionChecks: readonly {
    readonly assumptionId: string;
    readonly checkStatus: 'passed' | 'failed' | 'not-evaluated';
    readonly reasonCode?: string;
  }[];
  readonly recordDigest: string;
  readonly resultType?: 'scalar' | 'interval' | 'distribution' | 'table' | 'matrix' | 'curve';
  readonly numericValue?: number;
  readonly reasonCodes?: readonly string[];
  readonly errorCode?: string;
};

export interface CoreStudioDecision {
  readonly decisionPolicyId: string;
  readonly decisionStatus: 'decided' | 'not-decided' | 'failed';
  readonly implementation: CoreStudioRuntimeIdentity;
  readonly analysisResultIds: readonly string[];
  readonly decisionDigest: string;
  readonly verdict?: string;
  readonly reasonCodes?: readonly string[];
  readonly errorCode?: string;
}

export interface CoreStudioRunDetail {
  readonly detailKind: 'studio-core-run-detail';
  readonly schemaVersion: typeof CORE_STUDIO_RUN_DETAIL_SCHEMA_VERSION;
  readonly run: CoreStudioRunCard;
  readonly dataset: {
    readonly datasetId: string;
    readonly datasetRevisionDigest: string;
    readonly sampleCount: number;
  };
  readonly targets: readonly {
    readonly targetId: string;
    readonly targetKind: string;
    readonly protocolId: 'omk.invoke/v1' | 'omk.session/v1';
    readonly executorId: string;
  }[];
  readonly evaluators: readonly {
    readonly evaluatorId: string;
    readonly evaluatorKind: string;
    readonly implementationId: string;
    readonly metricIds: readonly string[];
    readonly measurement: {
      readonly instrumentId: string;
      readonly ensembleMemberId: string;
      readonly replicateGroupId: string;
      readonly replicateIndex: number;
    };
  }[];
  readonly metrics: readonly {
    readonly metricId: string;
    readonly valueType: 'numeric' | 'boolean' | 'categorical' | 'text' | 'ranking';
    readonly scope: 'sample' | 'target' | 'comparison' | 'run';
    readonly scale?: { readonly min?: number; readonly max?: number; readonly target?: number };
    readonly unit?: string;
    readonly direction?: 'higher-is-better' | 'lower-is-better' | 'target-is-best';
  }[];
  readonly stages: {
    readonly execution: {
      readonly bundleId: string;
      readonly bundleDigest: string;
      readonly stageStatus: 'completed' | 'cancelled' | 'budget-exhausted' | 'failed';
      readonly coverage: ExecutionCoverage;
      readonly replayability: 'self-contained' | 'resolvable' | 'summary-only';
      readonly budget: CoreStudioBudget;
      readonly provenance: CoreStudioProvenance;
      readonly records: readonly CoreStudioExecutionRecord[];
    };
    readonly evaluation: {
      readonly bundleId: string;
      readonly bundleDigest: string;
      readonly parentExecutionBundleDigest: string;
      readonly stageStatus: 'completed' | 'cancelled' | 'budget-exhausted' | 'failed';
      readonly coverage: EvaluationCoverage;
      readonly replayability: 'self-contained' | 'resolvable' | 'summary-only';
      readonly budget: CoreStudioBudget;
      readonly provenance: CoreStudioProvenance;
      readonly records: readonly CoreStudioEvaluationRecord[];
    };
    readonly analysis: {
      readonly bundleId: string;
      readonly bundleDigest: string;
      readonly parentEvaluationBundleDigest: string;
      readonly stageStatus: 'completed' | 'cancelled' | 'failed';
      readonly coverage: AnalysisCoverage;
      readonly provenance: CoreStudioProvenance;
      readonly records: readonly CoreStudioAnalysisRecord[];
    };
  };
  readonly decision?: CoreStudioDecision;
  readonly reportProvenance: CoreStudioProvenance;
  readonly lineage: readonly {
    readonly documentKind: 'run-plan' | 'execution-bundle' | 'evaluation-bundle' | 'analysis-bundle' | 'evaluation-report';
    readonly schemaVersion: string;
    readonly identityDigest: string;
    readonly documentDigest: string;
  }[];
}

export interface CoreStudioCatalog {
  list(): Promise<CoreStudioRunCard[]>;
  get(runId: string): Promise<CoreStudioRunDetail | undefined>;
  inspect(runId: string): Promise<CoreStudioRunCard | undefined>;
}
