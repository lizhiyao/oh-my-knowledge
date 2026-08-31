import type {
  EvaluationStatus,
  JsonValue,
  RuntimeIdentity,
  SeriesMemberCoverage,
} from '../../evaluation-core/contracts/index.js';

export const CORE_GOLD_COMPARISON_SCHEMA_VERSION =
  'omk.core-gold-comparison/v1' as const;
export const CORE_EVOLUTION_EVIDENCE_SCHEMA_VERSION =
  'omk.core-evolution-evidence/v1' as const;

export type CoreDownstreamProjectionErrorCode =
  | 'CORE_PROJECTION_SOURCE_INVALID'
  | 'CORE_GOLD_SELECTOR_INVALID'
  | 'CORE_GOLD_SCALE_INCOMPATIBLE'
  | 'CORE_GOLD_ANNOTATION_INVALID'
  | 'CORE_GOLD_OBSERVATION_AMBIGUOUS'
  | 'CORE_SERIES_SOURCE_INVALID';

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

export type CoreEvolutionDecisionEvidence =
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
  readonly decision?: CoreEvolutionDecisionEvidence;
}
