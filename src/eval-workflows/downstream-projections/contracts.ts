import type {
  AnalysisCoverage,
  EvaluationCoverage,
  EvaluationStatus,
  ExecutionCoverage,
  JsonValue,
  RuntimeIdentity,
  SeriesMemberCoverage,
} from '../../evaluation-core/contracts/index.js';

export const CORE_GOLD_COMPARISON_SCHEMA_VERSION =
  'omk.core-gold-comparison/v1' as const;
export const CORE_EVOLUTION_EVIDENCE_SCHEMA_VERSION =
  'omk.core-evolution-evidence/v1' as const;
export const CORE_CLI_DRY_RUN_SCHEMA_VERSION =
  'omk.cli-core-dry-run/v1' as const;
export const CORE_CLI_RUN_OUTCOME_SCHEMA_VERSION =
  'omk.cli-core-run-outcome/v1' as const;
export const CORE_CLI_BATCH_OUTCOME_SCHEMA_VERSION =
  'omk.cli-core-batch-outcome/v1' as const;
export const CORE_CLI_SERIES_OUTCOME_SCHEMA_VERSION =
  'omk.cli-core-series-outcome/v1' as const;
export const CORE_DIAGNOSTIC_PROJECTION_SCHEMA_VERSION =
  'omk.core-diagnostic-projection/v1' as const;
export const CORE_MANAGED_EVIDENCE_SCHEMA_VERSION =
  'omk.core-managed-evidence/v1' as const;

export type CoreDownstreamProjectionErrorCode =
  | 'CORE_PROJECTION_SOURCE_INVALID'
  | 'CORE_GOLD_SELECTOR_INVALID'
  | 'CORE_GOLD_SCALE_INCOMPATIBLE'
  | 'CORE_GOLD_ANNOTATION_INVALID'
  | 'CORE_GOLD_OBSERVATION_AMBIGUOUS'
  | 'CORE_SERIES_SOURCE_INVALID'
  | 'CORE_CLI_PLAN_INVALID'
  | 'CORE_CLI_OPTIONS_INVALID'
  | 'CORE_CLI_BATCH_SOURCE_INVALID'
  | 'CORE_CLI_SERIES_SOURCE_INVALID'
  | 'CORE_MANAGED_EVIDENCE_SOURCE_INVALID';

export class CoreDownstreamProjectionError extends Error {
  readonly code: CoreDownstreamProjectionErrorCode;

  constructor(code: CoreDownstreamProjectionErrorCode, message: string) {
    super(message);
    this.name = 'CoreDownstreamProjectionError';
    this.code = code;
  }
}

export interface CoreGoldMetricSelector {
  readonly targetId: string;
  readonly evaluatorId: string;
  readonly metricId: string;
  readonly trialIndex?: number;
  readonly instrumentId?: string;
  readonly ensembleMemberId?: string;
  readonly replicateGroupId?: string;
  readonly replicateIndex?: number;
}

export interface CoreGoldComparisonRow {
  readonly sampleId: string;
  readonly goldScore: number;
  readonly observedScore: number;
  readonly difference: number;
  readonly evaluationId: string;
  readonly observationId: string;
}

export interface CoreGoldAgreementResult {
  readonly alpha: number | null;
  readonly alphaCI: {
    readonly low: number | null;
    readonly high: number | null;
    readonly estimate: number | null;
    readonly samples: number;
  };
  readonly weightedKappa: number | null;
  readonly pearson: number | null;
  readonly sampleCount: number;
}

export interface CoreGoldComparisonResult {
  readonly projectionKind: 'core-gold-comparison';
  readonly schemaVersion: typeof CORE_GOLD_COMPARISON_SCHEMA_VERSION;
  readonly runContractDigest: string;
  readonly reportDigest: string;
  readonly gold: {
    readonly datasetDigest: string;
    readonly annotator: string;
    readonly annotatedAt: string;
    readonly version: string;
  };
  readonly selector: CoreGoldMetricSelector;
  readonly scale: { readonly min: number; readonly max: number };
  readonly evaluatorRuntime: RuntimeIdentity;
  readonly agreement: CoreGoldAgreementResult;
  readonly rows: readonly CoreGoldComparisonRow[];
  readonly missingSampleIds: readonly string[];
  readonly unscoredSampleIds: readonly string[];
  readonly contaminationWarning?: string;
}

export interface CoreEvolutionMemberEvidence {
  readonly memberId: string;
  readonly replicateIndex: number;
  readonly reportDigest: string;
  readonly runContractDigest: string;
  readonly status: EvaluationStatus;
  readonly effectiveTrust: 'verified' | 'declared' | 'untrusted' | 'unknown';
  readonly comparabilityStatus: 'anchor' | 'compatible' | 'conditional' | 'incompatible';
}

export type CoreEvolutionAnalysisEvidence = {
  readonly resultId: string;
  readonly nodeId: string;
  readonly analysisStandardId: string;
  readonly memberIds: readonly string[];
  readonly coverage: SeriesMemberCoverage;
  readonly assumptionChecks: readonly {
    readonly assumptionId: string;
    readonly checkStatus: 'passed' | 'failed' | 'not-evaluated';
    readonly reasonCode?: string;
  }[];
  readonly recordDigest: string;
} & (
  | {
    readonly analysisStatus: 'completed';
    readonly resultType: 'scalar' | 'interval' | 'distribution' | 'table' | 'matrix' | 'curve';
    readonly value: JsonValue;
  }
  | {
    readonly analysisStatus: 'inconclusive';
    readonly reasonCodes: readonly string[];
  }
  | {
    readonly analysisStatus: 'failed';
    readonly errorCode: string;
  }
);

export type CoreDecisionProjection =
  | {
    readonly decisionStatus: 'decided';
    readonly decisionPolicyId: string;
    readonly verdict: string;
    readonly reasonCodes: readonly string[];
    readonly decisionDigest: string;
  }
  | {
    readonly decisionStatus: 'not-decided';
    readonly decisionPolicyId: string;
    readonly reasonCodes: readonly string[];
    readonly decisionDigest: string;
  }
  | {
    readonly decisionStatus: 'failed';
    readonly decisionPolicyId: string;
    readonly errorCode: string;
    readonly decisionDigest: string;
  };

export type CoreEvolutionDecisionEvidence = CoreDecisionProjection;

export interface CoreEvolutionEvidence {
  readonly projectionKind: 'core-evolution-evidence';
  readonly schemaVersion: typeof CORE_EVOLUTION_EVIDENCE_SCHEMA_VERSION;
  readonly seriesId: string;
  readonly seriesPlanDigest: string;
  readonly analysisBundleDigest: string;
  readonly reportDigest: string;
  readonly analysisMode: 'preregistered' | 'exploratory';
  readonly experimentalUnit: 'run';
  readonly evidenceReadiness: 'decision-ready' | 'analysis-only' | 'insufficient';
  readonly coverage: SeriesMemberCoverage;
  readonly members: readonly CoreEvolutionMemberEvidence[];
  readonly analyses: readonly CoreEvolutionAnalysisEvidence[];
  readonly decision?: CoreDecisionProjection;
}

export interface CoreCliDryRunProjection {
  readonly projectionKind: 'core-cli-dry-run';
  readonly schemaVersion: typeof CORE_CLI_DRY_RUN_SCHEMA_VERSION;
  readonly runContractDigest: string;
  readonly stageDigests: {
    readonly executionPlanDigest: string;
    readonly evaluationPlanDigest: string;
    readonly analysisPlanDigest: string;
    readonly decisionPlanDigest: string;
  };
  readonly dataset: {
    readonly datasetId: string;
    readonly datasetRevisionDigest: string;
    readonly sampleCount: number;
  };
  readonly experiment: {
    readonly trials: number;
    readonly experimentalUnit: 'sample' | 'run' | 'cluster';
    readonly resamplingUnit: string;
    readonly repeatedMeasures: boolean;
  };
  readonly targets: readonly {
    readonly targetId: string;
    readonly targetKind: string;
    readonly protocolId: 'omk.invoke/v1' | 'omk.session/v1';
    readonly executorId: string;
  }[];
  readonly evaluation: {
    readonly evaluatorCount: number;
    readonly metricIds: readonly string[];
  };
  readonly analysis: {
    readonly analysisMode: 'preregistered' | 'exploratory';
    readonly nodeCount: number;
    readonly outputResultIds: readonly string[];
  };
  readonly decision?: {
    readonly decisionPolicyId: string;
    readonly implementationId: string;
  };
  readonly preflight: {
    readonly passed: number;
    readonly skipped: number;
    readonly notRequired: number;
    readonly records: readonly {
      readonly runtimeKind: string;
      readonly bindingId: string;
      readonly referenceId: string;
      readonly implementationId: string;
      readonly preflightKind: string;
      readonly checkId: string;
      readonly preflightStatus: 'passed' | 'skipped' | 'not-required';
      readonly reasonCode?: string;
    }[];
  };
}

export type CoreCliGateProjection = {
  readonly gateStatus: 'passed' | 'blocked' | 'skipped';
  readonly exitCode: 0 | 1;
  readonly reasonCodes: readonly string[];
};

export interface CoreCliRunOutcome {
  readonly projectionKind: 'core-cli-run-outcome';
  readonly schemaVersion: typeof CORE_CLI_RUN_OUTCOME_SCHEMA_VERSION;
  readonly runId: string;
  readonly reportId: string;
  readonly runContractDigest: string;
  readonly reportDigest: string;
  readonly artifactSetDigest: string;
  readonly createdAt: string;
  readonly status: EvaluationStatus;
  readonly stages: {
    readonly execution: {
      readonly bundleDigest: string;
      readonly stageStatus: 'completed' | 'cancelled' | 'budget-exhausted' | 'failed';
      readonly coverage: ExecutionCoverage;
    };
    readonly evaluation: {
      readonly bundleDigest: string;
      readonly stageStatus: 'completed' | 'cancelled' | 'budget-exhausted' | 'failed';
      readonly coverage: EvaluationCoverage;
    };
    readonly analysis: {
      readonly bundleDigest: string;
      readonly stageStatus: 'completed' | 'cancelled' | 'failed';
      readonly coverage: AnalysisCoverage;
    };
  };
  readonly usage: {
    readonly executionInvocations: number;
    readonly evaluationInvocations: number;
    readonly reportedProviderCosts: readonly {
      readonly amount: number;
      readonly currency: string;
    }[];
    readonly unreportedProviderCostInvocations: number;
  };
  readonly decision?: CoreDecisionProjection;
  readonly diagnostic?: CoreDiagnosticProjection;
  readonly gate: CoreCliGateProjection;
}

export interface CoreDiagnosticFinding {
  readonly findingId: string;
  readonly stage: 'execution' | 'evaluation' | 'analysis' | 'decision';
  readonly severity: 'info' | 'warning' | 'error';
  readonly reasonCode: string;
  readonly sourceDigest: string;
  readonly scope?: {
    readonly targetId?: string;
    readonly sampleId?: string;
    readonly trialIndex?: number;
    readonly evaluatorId?: string;
    readonly metricId?: string;
    readonly nodeId?: string;
  };
}

/** Recomputable, non-authoritative diagnostics over an authenticated Core artifact chain. */
export interface CoreDiagnosticProjection {
  readonly projectionKind: 'core-diagnostic';
  readonly schemaVersion: typeof CORE_DIAGNOSTIC_PROJECTION_SCHEMA_VERSION;
  readonly runId: string;
  readonly reportDigest: string;
  readonly status: EvaluationStatus;
  readonly findings: readonly CoreDiagnosticFinding[];
}

export interface CoreCliBatchOutcome {
  readonly projectionKind: 'core-cli-batch-outcome';
  readonly schemaVersion: typeof CORE_CLI_BATCH_OUTCOME_SCHEMA_VERSION;
  readonly batchId: string;
  readonly batchManifestDigest: string;
  readonly createdAt: string;
  readonly children: readonly {
    readonly itemId: string;
    readonly ordinal: number;
    readonly runId: string;
    readonly outcome: CoreCliRunOutcome;
  }[];
  readonly gate: CoreCliGateProjection;
}

export interface CoreCliSeriesOutcome {
  readonly projectionKind: 'core-cli-series-outcome';
  readonly schemaVersion: typeof CORE_CLI_SERIES_OUTCOME_SCHEMA_VERSION;
  readonly seriesId: string;
  readonly seriesPlanDigest: string;
  readonly reportDigest: string;
  readonly evidenceReadiness: CoreEvolutionEvidence['evidenceReadiness'];
  readonly coverage: SeriesMemberCoverage;
  readonly members: readonly {
    readonly memberId: string;
    readonly replicateIndex: number;
    readonly runId: string;
    readonly outcome: CoreCliRunOutcome;
  }[];
  readonly decision?: CoreDecisionProjection;
  readonly gate: CoreCliGateProjection;
}

export interface CoreRuntimeIdentityReference {
  readonly implementationId: string;
  readonly version?: string;
  readonly fingerprint: string;
  readonly fingerprintBasis: 'content-derived' | 'environment-derived' | 'self-reported' | 'opaque';
  readonly assuranceLevel: 'verified' | 'declared' | 'unknown';
}

export interface CoreManagedEvidenceProjection {
  readonly projectionKind: 'core-managed-evidence';
  readonly schemaVersion: typeof CORE_MANAGED_EVIDENCE_SCHEMA_VERSION;
  readonly runId: string;
  readonly reportId: string;
  readonly reportDigest: string;
  readonly runCreatedAt: string;
  readonly status: EvaluationStatus;
  readonly evidenceReadiness: 'decision-ready' | 'measurement-only' | 'insufficient';
  readonly comparability: {
    readonly runContractDigest: string;
    readonly datasetRevisionDigest: string;
    readonly executionPlanDigest: string;
    readonly evaluationPlanDigest: string;
    readonly analysisPlanDigest: string;
    readonly decisionPlanDigest: string;
  };
  readonly sampleCount: number;
  readonly targets: readonly {
    readonly targetId: string;
    readonly targetKind: string;
    readonly comparisonRoles: readonly {
      readonly comparisonId: string;
      readonly comparisonRole: 'control' | 'treatment';
    }[];
    readonly managedEvidenceEligible: boolean;
    readonly artifact: {
      readonly resourceId: string;
      readonly digest: string;
      readonly mediaType: string;
      readonly classification: 'public' | 'sensitive' | 'secret' | 'gold';
      readonly size: number;
    };
    readonly executorRuntime: CoreRuntimeIdentityReference;
  }[];
  readonly decision?: CoreDecisionProjection;
}
