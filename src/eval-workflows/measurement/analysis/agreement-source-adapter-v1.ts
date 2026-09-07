import { extractAgreementPairsFromGroups } from './agreement-source-pairs.js';
import type { AnalysisNodeExecutionContext } from '../../../eval-core/analysis/index.js';
import type { SchemaIdentity } from '../../../eval-core/contracts/index.js';
import type { AgreementParameters } from './agreement-parameters.js';
import type { AgreementPair } from './agreement-table.js';
import { round } from './analysis-support.js';
import {
  DIMENSION_TABLE_SCHEMA,
  parseDimensionTableEnvelope,
  type DimensionGroup,
} from './dimension-table-v1.js';

export const AGREEMENT_SOURCE_SCHEMAS = Object.freeze([
  DIMENSION_TABLE_SCHEMA,
]);

export function agreementSourceSchema(): SchemaIdentity {
  return DIMENSION_TABLE_SCHEMA;
}

function hasObservedAggregate(
  group: DimensionGroup,
): group is DimensionGroup & { aggregate: { aggregateStatus: 'observed'; mean: number } } {
  return group.aggregate.aggregateStatus === 'observed';
}

function judgeRating(groups: readonly DimensionGroup[]): AgreementPair['judge'] {
  if (groups.length === 0) {
    return {
      ratingStatus: 'unavailable',
      reasonCode: 'dimension-group-unavailable',
      sourceGroupIds: [],
      coverage: { plannedGroups: 0, observedGroups: 0, missingGroups: 0 },
    };
  }
  const observed = groups.filter(hasObservedAggregate);
  const coverage = {
    plannedGroups: groups.length,
    observedGroups: observed.length,
    missingGroups: groups.length - observed.length,
  };
  const sourceGroupIds = groups.map((group) => group.groupId);
  if (observed.length === 0) {
    return {
      ratingStatus: 'missing',
      reasonCode: 'dimension-unobserved',
      sourceGroupIds,
      coverage,
    };
  }
  return {
    ratingStatus: 'observed',
    score: round(
      observed.reduce((sum, group) => sum + group.aggregate.mean, 0) / observed.length,
      2,
    ),
    sourceGroupIds,
    coverage,
  };
}

export function extractAgreementPairs(
  parameters: AgreementParameters,
  envelope: unknown,
  samples: AnalysisNodeExecutionContext['samples'],
  signal?: AbortSignal,
): readonly AgreementPair[] {
  const table = parseDimensionTableEnvelope(envelope).value;
  return extractAgreementPairsFromGroups(parameters, table.groups, samples, judgeRating, signal);
}
