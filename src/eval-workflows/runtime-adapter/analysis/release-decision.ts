import { computeJudgeAgreement } from './judge-agreement.js';
import type {
  AnalysisDecisionPolicy,
  DecisionPolicyContext,
  DecisionPolicyOutput,
} from '../../../eval-core/analysis/index.js';
import {
  RuntimeIdentitySchema,
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
} from '../../../eval-core/contracts/index.js';
import {
  BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
} from './bootstrap-family-node-contract.js';
import {
  BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
} from './bootstrap-family-node-v2.js';
import {
  BOOTSTRAP_FAMILY_TABLE_SCHEMA,
  parseBootstrapFamilyTableEnvelope,
  type BootstrapComparison,
  type BootstrapFamilyTableValue,
} from './bootstrap-family-table.js';
import {
  BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
  parseBootstrapFamilyTableV2Envelope,
  type BootstrapComparisonV2,
  type BootstrapFamilyTableV2Value,
} from './bootstrap-family-table-v2.js';
import {
  COMPOSITE_TABLE_SCHEMA,
  parseCompositeTableEnvelope,
  type CompositeTableValue,
} from './composite-table.js';
import {
  JUDGE_ENSEMBLE_TABLE_SCHEMA,
  parseJudgeEnsembleTableEnvelope,
  type JudgeEnsembleGroup,
  type JudgeEnsembleTableValue,
} from './judge-aggregation.js';
import {
  RELEASE_DECISION_PARAMETERS_SCHEMA,
  RELEASE_DECISION_PARAMETERS_V3_SCHEMA,
  RELEASE_DECISION_PARAMETERS_V1_SCHEMA,
  parseReleaseDecisionParameters,
  parseReleaseDecisionParametersV3,
  parseReleaseDecisionParametersV1,
  type AnyReleaseDecisionParameters,
} from './release-decision-parameters.js';
import { compareStrings, round } from './analysis-support.js';

export const RELEASE_DECISION_POLICY_V1_IMPLEMENTATION_ID = 'omk.release-decision/v1' as const;
export const RELEASE_DECISION_POLICY_V2_IMPLEMENTATION_ID = 'omk.release-decision/v2' as const;
export const RELEASE_DECISION_POLICY_V3_IMPLEMENTATION_ID = 'omk.release-decision/v3' as const;
export const RELEASE_DECISION_POLICY_IMPLEMENTATION_ID = 'omk.release-decision/v4' as const;
export const RELEASE_DECISION_POLICY_V5_IMPLEMENTATION_ID = 'omk.release-decision/v5' as const;
export const RELEASE_DECISION_POLICY_V6_IMPLEMENTATION_ID = 'omk.release-decision/v6' as const;
export const RELEASE_DECISION_POLICY_V7_IMPLEMENTATION_ID = 'omk.release-decision/v7' as const;

function releaseDecisionCapabilities(
  parameterSchema: SchemaIdentity,
  bootstrapSchema: SchemaIdentity = BOOTSTRAP_FAMILY_TABLE_SCHEMA,
  bootstrapImplementationId: string = BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
): JsonValue {
  return {
    capabilityKind: 'decision-policy',
    analysisResultSchemaUris: [
      COMPOSITE_TABLE_SCHEMA.schemaUri,
      bootstrapSchema.schemaUri,
      JUDGE_ENSEMBLE_TABLE_SCHEMA.schemaUri,
    ].sort(compareStrings),
    multipleComparisonPolicyIds: [bootstrapImplementationId],
    parameterSchema,
    schemas: [
      COMPOSITE_TABLE_SCHEMA,
      bootstrapSchema,
      JUDGE_ENSEMBLE_TABLE_SCHEMA,
    ].sort((left, right) => (
      compareStrings(left.schemaUri, right.schemaUri)
      || compareStrings(left.schemaVersion, right.schemaVersion)
      || compareStrings(left.schemaDigest, right.schemaDigest)
    )),
  };
}

const RELEASE_DECISION_V1_CAPABILITIES = releaseDecisionCapabilities(
  RELEASE_DECISION_PARAMETERS_V1_SCHEMA,
);
const RELEASE_DECISION_CAPABILITIES = releaseDecisionCapabilities(
  RELEASE_DECISION_PARAMETERS_SCHEMA,
);
const RELEASE_DECISION_BOOTSTRAP_V2_CAPABILITIES = releaseDecisionCapabilities(
  RELEASE_DECISION_PARAMETERS_SCHEMA,
  BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
  BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
);
const RELEASE_DECISION_V7_CAPABILITIES = releaseDecisionCapabilities(
  RELEASE_DECISION_PARAMETERS_V3_SCHEMA,
  BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
  BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
);

export const RELEASE_DECISION_POLICY_V1_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: RELEASE_DECISION_POLICY_V1_IMPLEMENTATION_ID,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: RELEASE_DECISION_POLICY_V1_IMPLEMENTATION_ID,
      conclusionContract: [
        'SOLO',
        'UNDERPOWERED',
        'NOISE',
        'PROGRESS',
        'CAUTIOUS',
        'REGRESSION',
      ],
      precedence: [
        'not-decided-evidence-and-binding-gates',
        'solo',
        'regression',
        'cautious',
        'underpowered',
        'noise',
        'progress',
      ],
      comparisonInterval: 'sealed-bootstrap-family-rounded-bounds-significance',
      layerGate: 'two-decimal-mean-of-observed-composite-layer-facts-by-target',
      sampleSize: 'sealed-authored-sample-count',
      judgeDissent: 'legacy-pairwise-mean-pearson-over-complete-member-sample-matrix',
      repeatedTrials: 'mean-observed-member-or-composite-values-within-sample',
      holdout: 'train-minus-holdout-composite-with-minimum-scorable-partitions',
      multiTreatment: 'worst-conclusion-then-comparison-id',
      stabilityBoundary: 'evaluation-series-only',
      evidenceGate: 'complete-evidence-required-after-core-source-trust-and-assumption-gates',
      missingComparisonInterval: 'not-decided-no-point-estimate-fallback',
      directReportDependency: 'none',
      sourceSchemas: [
        COMPOSITE_TABLE_SCHEMA,
        BOOTSTRAP_FAMILY_TABLE_SCHEMA,
        JUDGE_ENSEMBLE_TABLE_SCHEMA,
      ],
      parameterSchema: RELEASE_DECISION_PARAMETERS_V1_SCHEMA,
      declaredCapabilities: RELEASE_DECISION_V1_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: RELEASE_DECISION_V1_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export const RELEASE_DECISION_POLICY_V2_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: RELEASE_DECISION_POLICY_V2_IMPLEMENTATION_ID,
    version: '2.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: RELEASE_DECISION_POLICY_V2_IMPLEMENTATION_ID,
      conclusionContract: [
        'SOLO',
        'UNDERPOWERED',
        'NOISE',
        'PROGRESS',
        'CAUTIOUS',
        'REGRESSION',
      ],
      precedence: [
        'not-decided-evidence-and-binding-gates',
        'solo',
        'regression',
        'cautious',
        'underpowered',
        'noise',
        'progress',
      ],
      comparisonInterval: 'sealed-bootstrap-family-rounded-bounds-significance',
      layerGate: 'two-decimal-mean-of-observed-composite-layer-facts-by-target',
      sampleSize: 'sealed-authored-sample-count',
      judgeDissent: 'pairwise-mean-pearson-over-complete-member-sample-matrix',
      judgeUncertainty:
        'positive-comparison-cautious-when-configured-ensemble-dissent-is-unmeasurable',
      repeatedTrials: 'mean-observed-member-or-composite-values-within-sample',
      holdout: 'train-minus-holdout-composite-with-minimum-scorable-partitions',
      multiTreatment: 'worst-conclusion-then-comparison-id',
      stabilityBoundary: 'evaluation-series-only',
      evidenceGate: 'complete-evidence-required-after-core-source-trust-and-assumption-gates',
      missingComparisonInterval: 'not-decided-no-point-estimate-fallback',
      directReportDependency: 'none',
      sourceSchemas: [
        COMPOSITE_TABLE_SCHEMA,
        BOOTSTRAP_FAMILY_TABLE_SCHEMA,
        JUDGE_ENSEMBLE_TABLE_SCHEMA,
      ],
      parameterSchema: RELEASE_DECISION_PARAMETERS_V1_SCHEMA,
      declaredCapabilities: RELEASE_DECISION_V1_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: RELEASE_DECISION_V1_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export const RELEASE_DECISION_POLICY_V3_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: RELEASE_DECISION_POLICY_V3_IMPLEMENTATION_ID,
    version: '3.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: RELEASE_DECISION_POLICY_V3_IMPLEMENTATION_ID,
      conclusionContract: [
        'SOLO',
        'UNDERPOWERED',
        'NOISE',
        'PROGRESS',
        'CAUTIOUS',
        'REGRESSION',
      ],
      precedence: [
        'not-decided-evidence-and-binding-gates',
        'solo',
        'regression',
        'cautious',
        'underpowered',
        'noise',
        'progress',
      ],
      comparisonInterval: 'sealed-bootstrap-family-rounded-bounds-significance',
      layerGate: 'two-decimal-mean-of-observed-composite-layer-facts-by-target',
      sampleSize:
        'paired-complete-pair-count-or-independent-minimum-observed-arm-count',
      judgeDissent: 'pairwise-mean-pearson-over-complete-member-sample-matrix',
      judgeUncertainty:
        'positive-comparison-cautious-when-configured-ensemble-dissent-is-unmeasurable',
      repeatedTrials: 'mean-observed-member-or-composite-values-within-sample',
      holdout: 'train-minus-holdout-composite-with-minimum-scorable-partitions',
      multiTreatment: 'worst-conclusion-then-comparison-id',
      stabilityBoundary: 'evaluation-series-only',
      evidenceGate: 'complete-evidence-required-after-core-source-trust-and-assumption-gates',
      missingComparisonInterval: 'not-decided-no-point-estimate-fallback',
      directReportDependency: 'none',
      sourceSchemas: [
        COMPOSITE_TABLE_SCHEMA,
        BOOTSTRAP_FAMILY_TABLE_SCHEMA,
        JUDGE_ENSEMBLE_TABLE_SCHEMA,
      ],
      parameterSchema: RELEASE_DECISION_PARAMETERS_V1_SCHEMA,
      declaredCapabilities: RELEASE_DECISION_V1_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: RELEASE_DECISION_V1_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export const RELEASE_DECISION_POLICY_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: RELEASE_DECISION_POLICY_IMPLEMENTATION_ID,
    version: '4.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: RELEASE_DECISION_POLICY_IMPLEMENTATION_ID,
      conclusionContract: [
        'SOLO',
        'UNDERPOWERED',
        'NOISE',
        'PROGRESS',
        'CAUTIOUS',
        'REGRESSION',
      ],
      precedence: [
        'not-decided-evidence-and-binding-gates',
        'solo',
        'regression',
        'cautious',
        'underpowered',
        'noise',
        'progress',
      ],
      comparisonInterval: 'sealed-bootstrap-family-rounded-bounds-significance',
      layerGate: 'two-decimal-mean-of-observed-composite-layer-facts-by-target',
      sampleSize:
        'observed-comparison-units-against-preregistered-minimum-or-a-priori-power-plan',
      powerPlanning:
        'paired-two-sided-normal-approximation-with-bonferroni-familywise-alpha',
      judgeDissent: 'pairwise-mean-pearson-over-complete-member-sample-matrix',
      judgeUncertainty:
        'positive-comparison-cautious-when-configured-ensemble-dissent-is-unmeasurable',
      repeatedTrials: 'mean-observed-member-or-composite-values-within-sample',
      holdout: 'train-minus-holdout-composite-with-minimum-scorable-partitions',
      multiTreatment: 'worst-conclusion-then-comparison-id',
      stabilityBoundary: 'evaluation-series-only',
      evidenceGate: 'complete-evidence-required-after-core-source-trust-and-assumption-gates',
      missingComparisonInterval: 'not-decided-no-point-estimate-fallback',
      directReportDependency: 'none',
      sourceSchemas: [
        COMPOSITE_TABLE_SCHEMA,
        BOOTSTRAP_FAMILY_TABLE_SCHEMA,
        JUDGE_ENSEMBLE_TABLE_SCHEMA,
      ],
      parameterSchema: RELEASE_DECISION_PARAMETERS_SCHEMA,
      declaredCapabilities: RELEASE_DECISION_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: RELEASE_DECISION_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export const RELEASE_DECISION_POLICY_V5_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: RELEASE_DECISION_POLICY_V5_IMPLEMENTATION_ID,
    version: '5.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: RELEASE_DECISION_POLICY_V5_IMPLEMENTATION_ID,
      conclusionContract: [
        'SOLO',
        'UNDERPOWERED',
        'NOISE',
        'PROGRESS',
        'CAUTIOUS',
        'REGRESSION',
      ],
      precedence: [
        'not-decided-evidence-and-binding-gates',
        'solo',
        'regression',
        'cautious',
        'underpowered',
        'noise',
        'progress',
      ],
      comparisonInterval:
        'sealed-bootstrap-family-v2-unrounded-tail-with-explicit-monte-carlo-error',
      monteCarloGate: 'indeterminate-significance-is-not-decided',
      nonsignificantReasonCode: 'comparison-not-significant',
      layerGate: 'two-decimal-mean-of-observed-composite-layer-facts-by-target',
      sampleSize:
        'observed-comparison-units-against-preregistered-minimum-or-a-priori-power-plan',
      powerPlanning:
        'paired-two-sided-normal-approximation-with-bonferroni-familywise-alpha',
      judgeDissent: 'pairwise-mean-pearson-over-complete-member-sample-matrix',
      judgeUncertainty:
        'positive-comparison-cautious-when-configured-ensemble-dissent-is-unmeasurable',
      repeatedTrials: 'mean-observed-member-or-composite-values-within-sample',
      holdout: 'train-minus-holdout-composite-with-minimum-scorable-partitions',
      multiTreatment: 'worst-conclusion-then-comparison-id',
      stabilityBoundary: 'evaluation-series-only',
      evidenceGate: 'complete-evidence-required-after-core-source-trust-and-assumption-gates',
      missingComparisonInterval: 'not-decided-no-point-estimate-fallback',
      directReportDependency: 'none',
      sourceSchemas: [
        COMPOSITE_TABLE_SCHEMA,
        BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
        JUDGE_ENSEMBLE_TABLE_SCHEMA,
      ],
      parameterSchema: RELEASE_DECISION_PARAMETERS_SCHEMA,
      declaredCapabilities: RELEASE_DECISION_BOOTSTRAP_V2_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: RELEASE_DECISION_BOOTSTRAP_V2_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export const RELEASE_DECISION_POLICY_V6_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: RELEASE_DECISION_POLICY_V6_IMPLEMENTATION_ID,
    version: '6.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: RELEASE_DECISION_POLICY_V6_IMPLEMENTATION_ID,
      conclusionContract: [
        'SOLO',
        'UNDERPOWERED',
        'NOISE',
        'PROGRESS',
        'CAUTIOUS',
        'REGRESSION',
      ],
      precedence: [
        'not-decided-evidence-and-binding-gates',
        'solo',
        'regression',
        'cautious',
        'underpowered',
        'noise',
        'progress',
      ],
      comparisonInterval:
        'sealed-bootstrap-family-v2-unrounded-tail-with-explicit-monte-carlo-error',
      monteCarloGate: 'indeterminate-significance-is-not-decided',
      nonsignificantReasonCode: 'comparison-not-significant',
      practicalEffectGate:
        'persisted-four-decimal-percentile-lower-bound-greater-than-or-equal-to-threshold',
      layerGate: 'two-decimal-mean-of-observed-composite-layer-facts-by-target',
      sampleSize:
        'observed-comparison-units-against-preregistered-minimum-or-a-priori-power-plan',
      powerPlanning:
        'paired-two-sided-normal-approximation-with-bonferroni-familywise-alpha',
      judgeDissent: 'pairwise-mean-pearson-over-complete-member-sample-matrix',
      judgeUncertainty:
        'positive-comparison-cautious-when-configured-ensemble-dissent-is-unmeasurable',
      repeatedTrials: 'mean-observed-member-or-composite-values-within-sample',
      holdout: 'train-minus-holdout-composite-with-minimum-scorable-partitions',
      multiTreatment: 'worst-conclusion-then-comparison-id',
      stabilityBoundary: 'evaluation-series-only',
      evidenceGate: 'complete-evidence-required-after-core-source-trust-and-assumption-gates',
      missingComparisonInterval: 'not-decided-no-point-estimate-fallback',
      directReportDependency: 'none',
      sourceSchemas: [
        COMPOSITE_TABLE_SCHEMA,
        BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
        JUDGE_ENSEMBLE_TABLE_SCHEMA,
      ],
      parameterSchema: RELEASE_DECISION_PARAMETERS_SCHEMA,
      declaredCapabilities: RELEASE_DECISION_BOOTSTRAP_V2_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: RELEASE_DECISION_BOOTSTRAP_V2_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

export const RELEASE_DECISION_POLICY_V7_IDENTITY: RuntimeIdentity = deepFreezeCanonicalJson(
  RuntimeIdentitySchema.parse({
    implementationId: RELEASE_DECISION_POLICY_V7_IMPLEMENTATION_ID,
    version: '7.0.0',
    fingerprint: digestCanonicalJson({
      implementationId: RELEASE_DECISION_POLICY_V7_IMPLEMENTATION_ID,
      predecessor: {
        implementationId: RELEASE_DECISION_POLICY_V6_IMPLEMENTATION_ID,
        fingerprint: RELEASE_DECISION_POLICY_V6_IDENTITY.fingerprint,
      },
      comparisonInterval:
        'sealed-bootstrap-family-v2-unrounded-tail-with-explicit-monte-carlo-error',
      practicalEffectGate:
        'persisted-four-decimal-percentile-lower-bound-greater-than-or-equal-to-threshold',
      judgeDissent:
        'every-applicable-rubric-dimension-pairwise-mean-pearson-over-complete-member-sample-matrix',
      judgeUncertainty:
        'any-applicable-dimension-unmeasurable-makes-positive-comparison-cautious',
      sourceSchemas: [
        COMPOSITE_TABLE_SCHEMA,
        BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA,
        JUDGE_ENSEMBLE_TABLE_SCHEMA,
      ],
      parameterSchema: RELEASE_DECISION_PARAMETERS_V3_SCHEMA,
      declaredCapabilities: RELEASE_DECISION_V7_CAPABILITIES,
    }),
    fingerprintBasis: 'self-reported',
    assuranceLevel: 'declared',
    capabilities: RELEASE_DECISION_V7_CAPABILITIES,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  }),
);

type CompletedResult = DecisionPolicyContext['results'][number];
type ReleaseVerdict = 'SOLO' | 'UNDERPOWERED' | 'NOISE' | 'PROGRESS'
  | 'CAUTIOUS' | 'REGRESSION';

interface ReleaseFacts {
  composite: CompositeTableValue;
  bootstrap: BootstrapFamilyTableValue | BootstrapFamilyTableV2Value;
  ensembles: ReadonlyMap<string, JudgeEnsembleTableValue>;
}

interface PairDecision {
  comparisonId: string;
  verdict: Exclude<ReleaseVerdict, 'SOLO'>;
  reasonCodes: string[];
}

function decided(verdict: ReleaseVerdict, reasonCodes: readonly string[]): DecisionPolicyOutput {
  return {
    decisionStatus: 'decided',
    verdict,
    reasonCodes: [...new Set(reasonCodes)].sort(compareStrings),
  };
}

function notDecided(...reasonCodes: string[]): DecisionPolicyOutput {
  return {
    decisionStatus: 'not-decided',
    reasonCodes: [...new Set(reasonCodes)].sort(compareStrings),
  };
}

function sameSchema(left: SchemaIdentity, right: SchemaIdentity): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function result(
  context: DecisionPolicyContext,
  resultId: string,
  schema: SchemaIdentity,
): CompletedResult | undefined {
  const matches = context.results.filter((candidate) => candidate.resultId === resultId);
  return matches.length === 1 && matches[0].resultType === 'table'
    && sameSchema(matches[0].outputSchema, schema)
    ? matches[0]
    : undefined;
}

type JudgeEnsembleSource = Readonly<{
  analysisResultId: string;
  metricId: string;
  instrumentId: string;
  replicateGroupId: string;
  applicableSampleIds?: readonly string[];
}>;

function judgeSources(parameters: AnyReleaseDecisionParameters): readonly JudgeEnsembleSource[] {
  return 'judgeEnsembles' in parameters.sources
    ? parameters.sources.judgeEnsembles ?? []
    : !('judgeEnsemble' in parameters.sources) || parameters.sources.judgeEnsemble === undefined
      ? []
      : [parameters.sources.judgeEnsemble];
}

function expectedResultIds(parameters: AnyReleaseDecisionParameters): string[] {
  return [
    parameters.sources.compositeResultId,
    parameters.sources.bootstrapFamilyResultId,
    ...judgeSources(parameters).map((source) => source.analysisResultId),
  ].sort(compareStrings);
}

function releaseFacts(
  context: DecisionPolicyContext,
  parameters: AnyReleaseDecisionParameters,
  bootstrapVersion: 'v1' | 'v2',
): ReleaseFacts | undefined {
  const expectedIds = expectedResultIds(parameters);
  const actualIds = context.results.map((candidate) => candidate.resultId).sort(compareStrings);
  const policyIds = [...context.policy.analysisResultIds].sort(compareStrings);
  if (canonicalizeJson(actualIds) !== canonicalizeJson(expectedIds)
      || canonicalizeJson(policyIds) !== canonicalizeJson(expectedIds)) return undefined;
  const composite = result(
    context,
    parameters.sources.compositeResultId,
    COMPOSITE_TABLE_SCHEMA,
  );
  const bootstrapSchema = bootstrapVersion === 'v1'
    ? BOOTSTRAP_FAMILY_TABLE_SCHEMA
    : BOOTSTRAP_FAMILY_TABLE_V2_SCHEMA;
  const bootstrap = result(
    context,
    parameters.sources.bootstrapFamilyResultId,
    bootstrapSchema,
  );
  const ensembleResults = judgeSources(parameters).map((source) => ({
    source,
    result: result(context, source.analysisResultId, JUDGE_ENSEMBLE_TABLE_SCHEMA),
  }));
  if (composite === undefined || bootstrap === undefined
      || ensembleResults.some((entry) => entry.result === undefined)) {
    return undefined;
  }
  return {
    composite: parseCompositeTableEnvelope({
      resultType: composite.resultType,
      value: composite.value,
    }).value,
    bootstrap: bootstrapVersion === 'v1'
      ? parseBootstrapFamilyTableEnvelope({
          resultType: bootstrap.resultType,
          value: bootstrap.value,
        }).value
      : parseBootstrapFamilyTableV2Envelope({
          resultType: bootstrap.resultType,
          value: bootstrap.value,
        }).value,
    ensembles: new Map(ensembleResults.map(({ source, result: ensemble }) => [
      source.analysisResultId,
      parseJudgeEnsembleTableEnvelope({
        resultType: ensemble!.resultType,
        value: ensemble!.value,
      }).value,
    ])),
  };
}

function validateSourceBindings(
  context: DecisionPolicyContext,
  parameters: AnyReleaseDecisionParameters,
  facts: ReleaseFacts,
  bootstrapImplementationId: string,
): boolean {
  const configuration = facts.bootstrap.configuration;
  const comparisonCount = configuration.comparisons.length;
  if ('sampleSizeRequirement' in parameters
      && parameters.sampleSizeRequirement.sampleSizePlanningKind === 'a-priori-power'
      && (parameters.sampleSizeRequirement.plannedComparisonCount !== comparisonCount
        || parameters.sampleSizeRequirement.familywiseAlpha !== configuration.alpha
        || configuration.comparisons.some((comparison) => (
          comparison.comparisonDesign !== 'paired'
        )))) return false;
  if (configuration.source.analysisResultId !== parameters.sources.compositeResultId
      || canonicalizeJson(configuration.targetIds) !== canonicalizeJson(parameters.targetIds)
      || canonicalizeJson(configuration.sampleIds) !== canonicalizeJson(parameters.sampleIds)
      || (comparisonCount === 0
        ? context.policy.comparisonFamilyResultId !== undefined
          || context.policy.multipleComparisonPolicyId !== undefined
        : context.policy.comparisonFamilyResultId
            !== parameters.sources.bootstrapFamilyResultId
          || (comparisonCount > 1
            ? context.policy.multipleComparisonPolicyId
                !== bootstrapImplementationId
            : context.policy.multipleComparisonPolicyId !== undefined))) {
    return false;
  }
  const targets = new Set(parameters.targetIds);
  const samples = new Set(parameters.sampleIds);
  if (facts.composite.groups.some((group) => (
    !targets.has(group.targetId) || !samples.has(group.sampleId)
  ))) return false;
  for (const targetId of parameters.targetIds) {
    for (const sampleId of parameters.sampleIds) {
      if (!facts.composite.groups.some((group) => (
        group.targetId === targetId && group.sampleId === sampleId
      ))) return false;
    }
  }
  const compositeById = new Map(facts.composite.groups.map((group) => [group.groupId, group]));
  if (facts.bootstrap.observations.length !== facts.composite.groups.length
      || facts.bootstrap.observations.some((observation) => {
        const source = compositeById.get(observation.sourceGroupId);
        if (source === undefined
            || source.targetId !== observation.targetId
            || source.sampleId !== observation.sampleId
            || source.trialIndex !== observation.trialIndex
            || source.trialId !== observation.trialId
            || canonicalizeJson(source.samplingUnitIds)
              !== canonicalizeJson(observation.samplingUnitIds)) return true;
        return source.aggregate.aggregateStatus === 'observed'
          ? observation.observationStatus !== 'observed'
            || observation.score !== source.aggregate.score
          : observation.observationStatus !== 'missing';
      })) return false;
  for (const source of judgeSources(parameters)) {
    const ensemble = facts.ensembles.get(source.analysisResultId);
    if (ensemble === undefined || ensemble.groups.some((group) => (
      !targets.has(group.targetId) || !samples.has(group.sampleId)
    ))) return false;
    const applicableSampleIds = source.applicableSampleIds ?? parameters.sampleIds;
    if (ensemble.groups.some((group) => !applicableSampleIds.includes(group.sampleId))) {
      return false;
    }
    for (const targetId of parameters.targetIds) {
      const selected = selectedJudgeGroups(ensemble, source, targetId);
      if (applicableSampleIds.some((sampleId) => (
        !selected.some((group) => group.sampleId === sampleId)
      ))) return false;
    }
  }
  const contrasts = [...context.contrasts].sort((left, right) => (
    compareStrings(left.comparisonId, right.comparisonId)
  ));
  const comparisons = configuration.comparisons;
  if (contrasts.length !== comparisons.length) return false;
  return contrasts.every((contrast, index) => {
    const comparison = comparisons[index];
    return contrast.analysisResultId === parameters.sources.bootstrapFamilyResultId
      && comparison !== undefined
      && contrast.comparisonId === comparison.comparisonId
      && contrast.controlTargetId === comparison.controlTargetId
      && contrast.treatmentTargetId === comparison.treatmentTargetId;
  });
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function layerMeans(
  table: CompositeTableValue,
  targetId: string,
): ReadonlyMap<'fact' | 'behavior' | 'judge', number> {
  const values = new Map<'fact' | 'behavior' | 'judge', number[]>();
  for (const group of table.groups.filter((candidate) => candidate.targetId === targetId)) {
    for (const layer of group.layers) {
      if (layer.layerStatus !== 'observed') continue;
      const scores = values.get(layer.binding.layerId) ?? [];
      scores.push(layer.score);
      values.set(layer.binding.layerId, scores);
    }
  }
  return new Map([...values].map(([layerId, scores]) => [layerId, round(mean(scores), 2)]));
}

function layerGate(
  table: CompositeTableValue,
  targetId: string,
  threshold: number,
): 'passed' | 'failed' {
  const layers = [...layerMeans(table, targetId).values()];
  return layers.length > 0 && layers.every((score) => score >= threshold)
    ? 'passed'
    : 'failed';
}

function sampleCompositeScores(
  table: CompositeTableValue,
  targetId: string,
): ReadonlyMap<string, number> {
  const bySample = new Map<string, number[]>();
  for (const group of table.groups) {
    if (group.targetId !== targetId || group.aggregate.aggregateStatus !== 'observed') continue;
    const scores = bySample.get(group.sampleId) ?? [];
    scores.push(group.aggregate.score);
    bySample.set(group.sampleId, scores);
  }
  return new Map([...bySample].map(([sampleId, scores]) => [
    sampleId,
    round(mean(scores), 2),
  ]));
}

function holdoutGated(
  parameters: AnyReleaseDecisionParameters,
  table: CompositeTableValue,
  targetId: string,
): boolean {
  if (parameters.holdout === undefined) return false;
  const scores = sampleCompositeScores(table, targetId);
  const train = parameters.holdout.trainSampleIds.flatMap((sampleId) => {
    const score = scores.get(sampleId);
    return score === undefined ? [] : [score];
  });
  const holdout = parameters.holdout.holdoutSampleIds.flatMap((sampleId) => {
    const score = scores.get(sampleId);
    return score === undefined ? [] : [score];
  });
  const minimum = parameters.holdout.minimumScorablePerPartition;
  if (train.length < minimum || holdout.length < minimum) return false;
  return round(mean(train), 2) - round(mean(holdout), 2) > parameters.thresholds.holdoutGap;
}

function selectedJudgeGroups(
  table: JudgeEnsembleTableValue,
  source: JudgeEnsembleSource,
  targetId: string,
): JudgeEnsembleGroup[] {
  return table.groups.filter((group) => (
    group.targetId === targetId
    && group.metricId === source.metricId
    && group.instrumentId === source.instrumentId
    && group.replicateGroupId === source.replicateGroupId
  ));
}

function judgePearson(
  table: JudgeEnsembleTableValue,
  source: JudgeEnsembleSource,
  targetId: string,
): number | undefined {
  const groups = selectedJudgeGroups(table, source, targetId);
  const memberIds = [...new Set(groups.flatMap((group) => (
    group.members.map((member) => member.ensembleMemberId)
  )))].sort(compareStrings);
  if (memberIds.length < 2) return undefined;
  const byMember = new Map(memberIds.map((memberId) => [memberId, new Map<string, number[]>()]));
  for (const group of groups) {
    for (const member of group.members) {
      if (member.memberStatus !== 'observed') continue;
      const bySample = byMember.get(member.ensembleMemberId);
      if (bySample === undefined) continue;
      const values = bySample.get(group.sampleId) ?? [];
      values.push(member.mean);
      bySample.set(group.sampleId, values);
    }
  }
  const matrix = memberIds.map(() => [] as number[]);
  for (const sampleId of source.applicableSampleIds ?? []) {
    const sampleValues = memberIds.map((memberId) => {
      const values = byMember.get(memberId)?.get(sampleId);
      return values === undefined || values.length === 0 ? undefined : mean(values);
    });
    if (sampleValues.some((value) => value === undefined)) continue;
    sampleValues.forEach((value, index) => { matrix[index].push(value as number); });
  }
  if (matrix[0]?.length === undefined || matrix[0].length < 2) return undefined;
  return computeJudgeAgreement(matrix).pearson;
}

function judgeAssessment(
  facts: ReleaseFacts,
  parameters: AnyReleaseDecisionParameters,
  controlTargetId: string,
  treatmentTargetId: string,
): Readonly<{ dissent: boolean; uncertaintyUnmeasured: boolean }> {
  const sources = judgeSources(parameters);
  if (sources.length === 0) {
    return { dissent: false, uncertaintyUnmeasured: false };
  }
  const correlations = sources.flatMap((source) => {
    const table = facts.ensembles.get(source.analysisResultId);
    return table === undefined ? [undefined] : [controlTargetId, treatmentTargetId].map((targetId) => (
      judgePearson(table, {
        ...source,
        applicableSampleIds: source.applicableSampleIds ?? parameters.sampleIds,
      }, targetId)
    ));
  });
  return {
    dissent: correlations.some((pearson) => (
      pearson !== undefined && pearson < parameters.thresholds.judgeDissentPearson
    )),
    uncertaintyUnmeasured: correlations.some((pearson) => pearson === undefined),
  };
}

interface ReleaseDecisionSemantics {
  readonly gateUnmeasuredJudgeUncertainty: boolean;
  readonly sampleSizeBasis: 'authored-samples' | 'observed-comparison-units';
  readonly parameterSchemaVersion: 'v1' | 'v2' | 'v3';
  readonly bootstrapVersion: 'v1' | 'v2';
  readonly bootstrapImplementationId: string;
  readonly practicalEffectBasis: 'point-estimate' | 'interval-lower-bound';
}

type ObservedBootstrapComparison =
  | Extract<BootstrapComparison, { comparisonStatus: 'observed' }>
  | Extract<BootstrapComparisonV2, { comparisonStatus: 'observed' }>;

function comparisonUnitCount(
  comparison: ObservedBootstrapComparison,
  parameters: AnyReleaseDecisionParameters,
  semantics: ReleaseDecisionSemantics,
): number {
  if (semantics.sampleSizeBasis === 'authored-samples') return parameters.sampleIds.length;
  return comparison.binding.comparisonDesign === 'paired'
    ? comparison.counts.comparableUnits ?? 0
    : Math.min(comparison.counts.controlUnits, comparison.counts.treatmentUnits);
}

function minimumComparisonUnitCount(parameters: AnyReleaseDecisionParameters): number {
  return 'sampleSizeRequirement' in parameters
    ? parameters.sampleSizeRequirement.minimumComparisonUnits
    : parameters.thresholds.minimumSampleCount;
}

function pairDecision(
  comparison: ObservedBootstrapComparison,
  facts: ReleaseFacts,
  parameters: AnyReleaseDecisionParameters,
  semantics: ReleaseDecisionSemantics,
): PairDecision {
  const binding = comparison.binding;
  const interval = comparison.interval;
  const significant = 'significance' in comparison
    ? comparison.significance.significanceStatus === 'significant'
    : comparison.interval.significant;
  if (!significant) {
    const reason = 'significance' in comparison
      ? 'comparison-not-significant'
      : 'comparison-interval-overlaps-zero';
    return comparisonUnitCount(comparison, parameters, semantics)
      < minimumComparisonUnitCount(parameters)
      ? {
        comparisonId: binding.comparisonId,
        verdict: 'UNDERPOWERED',
        reasonCodes: [
          reason,
          'comparison-sample-size-below-minimum',
        ],
      }
      : {
        comparisonId: binding.comparisonId,
        verdict: 'NOISE',
        reasonCodes: [
          reason,
          'comparison-sample-size-sufficient',
        ],
      };
  }
  if (interval.estimate < 0) {
    return {
      comparisonId: binding.comparisonId,
      verdict: 'REGRESSION',
      reasonCodes: ['comparison-significant-regression'],
    };
  }
  const reasons = ['comparison-significant-progress'];
  if (layerGate(
    facts.composite,
    binding.treatmentTargetId,
    parameters.thresholds.layerScore,
  ) === 'failed') reasons.push('treatment-layer-gate-failed');
  const practicalEffect = semantics.practicalEffectBasis === 'point-estimate'
    ? interval.estimate
    : interval.lower;
  if (practicalEffect < parameters.thresholds.triviallySmallDifference) {
    reasons.push('comparison-effect-practically-trivial');
  }
  const judge = judgeAssessment(
    facts,
    parameters,
    binding.controlTargetId,
    binding.treatmentTargetId,
  );
  if (judge.dissent) reasons.push('judge-ensemble-dissent');
  if (semantics.gateUnmeasuredJudgeUncertainty && judge.uncertaintyUnmeasured) {
    reasons.push('judge-uncertainty-unmeasured');
  }
  if (holdoutGated(parameters, facts.composite, binding.treatmentTargetId)) {
    reasons.push('holdout-generalization-gap');
  }
  if (reasons.length > 1) {
    return { comparisonId: binding.comparisonId, verdict: 'CAUTIOUS', reasonCodes: reasons };
  }
  if (layerGate(
    facts.composite,
    binding.controlTargetId,
    parameters.thresholds.layerScore,
  ) === 'failed') reasons.push('treatment-recovers-broken-control');
  reasons.push('release-gates-passed');
  return { comparisonId: binding.comparisonId, verdict: 'PROGRESS', reasonCodes: reasons };
}

const VERDICT_PRECEDENCE: Readonly<Record<Exclude<ReleaseVerdict, 'SOLO'>, number>> = {
  REGRESSION: 0,
  CAUTIOUS: 1,
  UNDERPOWERED: 2,
  NOISE: 3,
  PROGRESS: 4,
};

function decideRelease(
  context: DecisionPolicyContext,
  semantics: ReleaseDecisionSemantics,
): DecisionPolicyOutput {
  if (context.signal.aborted) return notDecided('decision-cancelled');
  if (context.evidenceStatus !== 'complete') return notDecided('release-evidence-incomplete');
  const parameters = semantics.parameterSchemaVersion === 'v1'
    ? parseReleaseDecisionParametersV1(context.policy.parameters)
    : semantics.parameterSchemaVersion === 'v2'
      ? parseReleaseDecisionParameters(context.policy.parameters)
      : parseReleaseDecisionParametersV3(context.policy.parameters);
  const facts = releaseFacts(context, parameters, semantics.bootstrapVersion);
  if (facts === undefined) return notDecided('release-analysis-result-binding-mismatch');
  if (!validateSourceBindings(
    context,
    parameters,
    facts,
    semantics.bootstrapImplementationId,
  )) {
    return notDecided('release-analysis-source-lineage-mismatch');
  }
  if (context.contrasts.length === 0) {
    return parameters.targetIds.length === 1
      ? decided('SOLO', [
        'single-target-no-comparison',
        layerGate(facts.composite, parameters.targetIds[0], parameters.thresholds.layerScore)
          === 'passed'
          ? 'solo-layer-gate-passed'
          : 'solo-layer-gate-failed',
      ])
      : notDecided('release-comparison-family-unavailable');
  }
  const decisions: PairDecision[] = [];
  for (const comparison of facts.bootstrap.comparisons) {
    if (comparison.comparisonStatus !== 'observed') {
      return notDecided('release-comparison-interval-unavailable');
    }
    if ('significance' in comparison
        && comparison.significance.significanceStatus === 'indeterminate') {
      return notDecided('release-bootstrap-monte-carlo-indeterminate');
    }
    decisions.push(pairDecision(comparison, facts, parameters, semantics));
  }
  if (decisions.length !== context.contrasts.length) {
    return notDecided('release-comparison-family-mismatch');
  }
  decisions.sort((left, right) => (
    VERDICT_PRECEDENCE[left.verdict] - VERDICT_PRECEDENCE[right.verdict]
    || compareStrings(left.comparisonId, right.comparisonId)
  ));
  const representative = decisions[0];
  return decided(representative.verdict, representative.reasonCodes);
}

export const RELEASE_DECISION_POLICY: AnalysisDecisionPolicy = {
  identity: RELEASE_DECISION_POLICY_IDENTITY,
  decide: async (context) => decideRelease(context, {
    gateUnmeasuredJudgeUncertainty: true,
    sampleSizeBasis: 'observed-comparison-units',
    parameterSchemaVersion: 'v2',
    bootstrapVersion: 'v1',
    bootstrapImplementationId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
    practicalEffectBasis: 'point-estimate',
  }),
};

export const RELEASE_DECISION_POLICY_V5: AnalysisDecisionPolicy = {
  identity: RELEASE_DECISION_POLICY_V5_IDENTITY,
  decide: async (context) => decideRelease(context, {
    gateUnmeasuredJudgeUncertainty: true,
    sampleSizeBasis: 'observed-comparison-units',
    parameterSchemaVersion: 'v2',
    bootstrapVersion: 'v2',
    bootstrapImplementationId: BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
    practicalEffectBasis: 'point-estimate',
  }),
};

export const RELEASE_DECISION_POLICY_V6: AnalysisDecisionPolicy = {
  identity: RELEASE_DECISION_POLICY_V6_IDENTITY,
  decide: async (context) => decideRelease(context, {
    gateUnmeasuredJudgeUncertainty: true,
    sampleSizeBasis: 'observed-comparison-units',
    parameterSchemaVersion: 'v2',
    bootstrapVersion: 'v2',
    bootstrapImplementationId: BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
    practicalEffectBasis: 'interval-lower-bound',
  }),
};

export const RELEASE_DECISION_POLICY_V7: AnalysisDecisionPolicy = {
  identity: RELEASE_DECISION_POLICY_V7_IDENTITY,
  decide: async (context) => decideRelease(context, {
    gateUnmeasuredJudgeUncertainty: true,
    sampleSizeBasis: 'observed-comparison-units',
    parameterSchemaVersion: 'v3',
    bootstrapVersion: 'v2',
    bootstrapImplementationId: BOOTSTRAP_FAMILY_ANALYSIS_V2_IMPLEMENTATION_ID,
    practicalEffectBasis: 'interval-lower-bound',
  }),
};

export const RELEASE_DECISION_POLICY_V3: AnalysisDecisionPolicy = {
  identity: RELEASE_DECISION_POLICY_V3_IDENTITY,
  decide: async (context) => decideRelease(context, {
    gateUnmeasuredJudgeUncertainty: true,
    sampleSizeBasis: 'observed-comparison-units',
    parameterSchemaVersion: 'v1',
    bootstrapVersion: 'v1',
    bootstrapImplementationId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
    practicalEffectBasis: 'point-estimate',
  }),
};

export const RELEASE_DECISION_POLICY_V2: AnalysisDecisionPolicy = {
  identity: RELEASE_DECISION_POLICY_V2_IDENTITY,
  decide: async (context) => decideRelease(context, {
    gateUnmeasuredJudgeUncertainty: true,
    sampleSizeBasis: 'authored-samples',
    parameterSchemaVersion: 'v1',
    bootstrapVersion: 'v1',
    bootstrapImplementationId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
    practicalEffectBasis: 'point-estimate',
  }),
};

export const RELEASE_DECISION_POLICY_V1: AnalysisDecisionPolicy = {
  identity: RELEASE_DECISION_POLICY_V1_IDENTITY,
  decide: async (context) => decideRelease(context, {
    gateUnmeasuredJudgeUncertainty: false,
    sampleSizeBasis: 'authored-samples',
    parameterSchemaVersion: 'v1',
    bootstrapVersion: 'v1',
    bootstrapImplementationId: BOOTSTRAP_FAMILY_ANALYSIS_IMPLEMENTATION_ID,
    practicalEffectBasis: 'point-estimate',
  }),
};

export function createReleaseDecisionPolicies(): ReadonlyMap<string, AnalysisDecisionPolicy> {
  return new Map([
    [RELEASE_DECISION_POLICY_V1_IMPLEMENTATION_ID, RELEASE_DECISION_POLICY_V1],
    [RELEASE_DECISION_POLICY_V2_IMPLEMENTATION_ID, RELEASE_DECISION_POLICY_V2],
    [RELEASE_DECISION_POLICY_V3_IMPLEMENTATION_ID, RELEASE_DECISION_POLICY_V3],
    [RELEASE_DECISION_POLICY_IMPLEMENTATION_ID, RELEASE_DECISION_POLICY],
    [RELEASE_DECISION_POLICY_V5_IMPLEMENTATION_ID, RELEASE_DECISION_POLICY_V5],
    [RELEASE_DECISION_POLICY_V6_IMPLEMENTATION_ID, RELEASE_DECISION_POLICY_V6],
    [RELEASE_DECISION_POLICY_V7_IMPLEMENTATION_ID, RELEASE_DECISION_POLICY_V7],
  ]);
}
