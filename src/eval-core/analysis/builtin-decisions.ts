/**
 * 内建分析的缺失值策略与三个决策策略（progress、interval-progress、family-release）。
 */
import {
  canonicalizeJson,
  type JsonValue,
} from '../contracts/index.js';
import type {
  AnalysisDecisionPolicy,
  DecisionPolicyContext,
  DecisionPolicyOutput,
} from './types.js';
import {
  EXCLUDE_CAPABILITIES,
  FAMILY_RELEASE_DECISION_CAPABILITIES,
  FAMILY_RELEASE_DECISION_FINGERPRINT_FACETS,
  PROGRESS_V1_DECISION_CAPABILITIES,
  PROGRESS_V1_DECISION_FINGERPRINT_FACETS,
  PROGRESS_V2_DECISION_CAPABILITIES,
  PROGRESS_V2_DECISION_FINGERPRINT_FACETS,
  runtimeIdentity,
} from './builtin-identity.js';
import {
  FamilyReleaseParametersSchema,
  IntervalEnvelopeSchema,
  SimultaneousIntervalFamilyEnvelopeSchema,
} from './builtin-schemas.js';

export const BUILTIN_EXCLUDE_MISSING_POLICY = {
  identity: runtimeIdentity('exclude/v1', EXCLUDE_CAPABILITIES),
  decide: () => 'exclude' as const,
};


function selectedDecisionResult(
  context: DecisionPolicyContext,
): DecisionPolicyContext['results'][number] | undefined {
  const resultId = context.contrasts.length === 1
    ? context.contrasts[0].analysisResultId
    : context.contrasts.length === 0 && context.results.length === 1
      ? context.results[0].resultId
      : undefined;
  return resultId === undefined
    ? undefined
    : context.results.find((candidate) => candidate.resultId === resultId);
}


function scalarEffect(context: DecisionPolicyContext): number | undefined {
  const result = selectedDecisionResult(context);
  if (result === undefined) return undefined;
  if (typeof result.value === 'number' && Number.isFinite(result.value)) return result.value;
  if (result.value !== null && !Array.isArray(result.value)
      && typeof result.value === 'object') {
    const value = (result.value as Record<string, JsonValue>).estimate;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}


function intervalEffect(
  context: DecisionPolicyContext,
): Readonly<{ estimate: number; lower: number; upper: number }> | undefined {
  const result = selectedDecisionResult(context);
  if (result === undefined) return undefined;
  const parsed = IntervalEnvelopeSchema.safeParse({
    resultType: result.resultType,
    value: result.value,
  });
  return parsed.success ? parsed.data.value : undefined;
}


function progressParameters(context: DecisionPolicyContext): {
  threshold: number;
  equivalence: number;
} {
  const policyParameters = context.policy.parameters;
  const object = policyParameters !== null && policyParameters !== undefined
    && !Array.isArray(policyParameters) && typeof policyParameters === 'object'
    ? policyParameters as Record<string, JsonValue>
    : {};
  return {
    threshold: typeof object.threshold === 'number' ? object.threshold : 0,
    equivalence: typeof object.equivalence === 'number' ? object.equivalence : 0,
  };
}


export const BUILTIN_PROGRESS_DECISION_POLICY: AnalysisDecisionPolicy = {
  identity: runtimeIdentity(
    'progress/v1',
    PROGRESS_V1_DECISION_CAPABILITIES,
    PROGRESS_V1_DECISION_FINGERPRINT_FACETS,
  ),
  decide: async (context): Promise<DecisionPolicyOutput> => {
    const effect = scalarEffect(context);
    if (effect === undefined) {
      return { decisionStatus: 'not-decided', reasonCodes: ['decision-effect-unavailable'] };
    }
    const { threshold, equivalence } = progressParameters(context);
    if (effect > threshold + equivalence) {
      return {
        decisionStatus: 'decided',
        verdict: 'PROGRESS',
        reasonCodes: ['effect-above-progress-threshold'],
      };
    }
    if (effect < threshold - equivalence) {
      return {
        decisionStatus: 'decided',
        verdict: 'REGRESSION',
        reasonCodes: ['effect-below-regression-threshold'],
      };
    }
    return {
      decisionStatus: 'decided',
      verdict: 'NOISE',
      reasonCodes: ['effect-within-equivalence-band'],
    };
  },
};


export const BUILTIN_INTERVAL_PROGRESS_DECISION_POLICY: AnalysisDecisionPolicy = {
  identity: runtimeIdentity(
    'progress/v2',
    PROGRESS_V2_DECISION_CAPABILITIES,
    PROGRESS_V2_DECISION_FINGERPRINT_FACETS,
  ),
  decide: async (context): Promise<DecisionPolicyOutput> => {
    const interval = intervalEffect(context);
    if (interval === undefined) {
      return { decisionStatus: 'not-decided', reasonCodes: ['decision-interval-unavailable'] };
    }
    const { threshold, equivalence } = progressParameters(context);
    if (interval.lower > threshold + equivalence) {
      return {
        decisionStatus: 'decided',
        verdict: 'PROGRESS',
        reasonCodes: ['interval-above-progress-boundary'],
      };
    }
    if (interval.upper < threshold - equivalence) {
      return {
        decisionStatus: 'decided',
        verdict: 'REGRESSION',
        reasonCodes: ['interval-below-regression-boundary'],
      };
    }
    return {
      decisionStatus: 'decided',
      verdict: 'NOISE',
      reasonCodes: ['interval-overlaps-decision-boundary'],
    };
  },
};


export const BUILTIN_FAMILY_RELEASE_DECISION_POLICY: AnalysisDecisionPolicy = {
  identity: runtimeIdentity(
    'release-family/v1',
    FAMILY_RELEASE_DECISION_CAPABILITIES,
    FAMILY_RELEASE_DECISION_FINGERPRINT_FACETS,
  ),
  decide: async (context): Promise<DecisionPolicyOutput> => {
    const parameters = FamilyReleaseParametersSchema.safeParse(context.policy.parameters);
    if (!parameters.success || context.results.length !== 1) {
      return {
        decisionStatus: 'not-decided',
        reasonCodes: ['decision-family-contract-unavailable'],
      };
    }
    const family = SimultaneousIntervalFamilyEnvelopeSchema.safeParse({
      resultType: context.results[0].resultType,
      value: context.results[0].value,
    });
    if (!family.success) {
      return {
        decisionStatus: 'not-decided',
        reasonCodes: ['decision-family-contract-unavailable'],
      };
    }
    const criterionIds = parameters.data.criteria.map(
      (criterion) => criterion.analysisResultId,
    ).sort();
    const familyIds = family.data.value.members.map(
      (member) => member.analysisResultId,
    ).sort();
    const contrastIds = context.contrasts.map((contrast) => contrast.analysisResultId).sort();
    if (canonicalizeJson(criterionIds) !== canonicalizeJson(familyIds)
        || canonicalizeJson(criterionIds) !== canonicalizeJson(contrastIds)) {
      return {
        decisionStatus: 'not-decided',
        reasonCodes: ['decision-family-contract-unavailable'],
      };
    }
    const intervalsById = new Map(family.data.value.members.map(
      (member) => [member.analysisResultId, member.interval],
    ));
    let uncertain = false;
    for (const criterion of parameters.data.criteria) {
      const interval = intervalsById.get(criterion.analysisResultId);
      if (interval === undefined) {
        return {
          decisionStatus: 'not-decided',
          reasonCodes: ['decision-family-contract-unavailable'],
        };
      }
      const provenUnacceptable = (
        criterion.minimumEffect !== undefined && interval.upper < criterion.minimumEffect
      ) || (
        criterion.maximumEffect !== undefined && interval.lower > criterion.maximumEffect
      );
      if (provenUnacceptable) {
        return {
          decisionStatus: 'decided',
          verdict: 'BLOCK',
          reasonCodes: ['family-criterion-unacceptable'],
        };
      }
      const provenAcceptable = (
        criterion.minimumEffect === undefined || interval.lower >= criterion.minimumEffect
      ) && (
        criterion.maximumEffect === undefined || interval.upper <= criterion.maximumEffect
      );
      if (!provenAcceptable) uncertain = true;
    }
    return uncertain
      ? {
        decisionStatus: 'not-decided',
        reasonCodes: ['family-criterion-uncertain'],
      }
      : {
        decisionStatus: 'decided',
        verdict: 'RELEASE',
        reasonCodes: ['all-family-criteria-acceptable'],
      };
  },
};

