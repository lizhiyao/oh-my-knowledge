import type { AnalysisNodeExecutionContext } from '../../../evaluation-core/analysis/index.js';
import type { SchemaIdentity } from '../../../evaluation-core/contracts/index.js';
import type { AgreementParameters } from './agreement-parameters.js';
import type { AgreementPair } from './agreement-table.js';
import { round } from './analysis-support.js';
import {
  DIMENSION_TABLE_SCHEMA,
  parseDimensionTableEnvelope,
  type DimensionGroup,
} from './dimension-table.js';

export const AGREEMENT_SOURCE_SCHEMAS = Object.freeze([
  DIMENSION_TABLE_SCHEMA,
]);

export function agreementSourceSchema(): SchemaIdentity {
  return DIMENSION_TABLE_SCHEMA;
}

function decodePointerToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolvePointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let current: unknown = value;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = decodePointerToken(rawToken);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current !== null && typeof current === 'object') {
      const record = current as Readonly<Record<string, unknown>>;
      current = Object.prototype.hasOwnProperty.call(current, token)
        ? record[token]
        : undefined;
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function hasObservedAggregate(
  group: DimensionGroup,
): group is DimensionGroup & { aggregate: { aggregateStatus: 'observed'; mean: number } } {
  return group.aggregate.aggregateStatus === 'observed';
}

function goldRating(
  sample: AnalysisNodeExecutionContext['samples'][number],
  parameters: AgreementParameters,
): AgreementPair['gold'] {
  const context = sample.analysis?.context;
  if (context === undefined) {
    return { ratingStatus: 'unavailable', reasonCode: 'gold-rating-unavailable' };
  }
  if (context.classification !== 'gold') {
    throw new TypeError('Agreement gold context must use the gold classification.');
  }
  const score = resolvePointer(context.value, parameters.gold.contextPointer);
  return typeof score === 'number' && Number.isFinite(score)
    ? { ratingStatus: 'observed', score }
    : { ratingStatus: 'unavailable', reasonCode: 'gold-rating-unavailable' };
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
  const sampleSet = new Set(parameters.sampleIds);
  const groupsBySample = new Map<string, DimensionGroup[]>();
  for (const group of table.groups) {
    if (signal?.aborted === true) throw signal.reason;
    if (group.targetId !== parameters.source.targetId) continue;
    if (!sampleSet.has(group.sampleId)) {
      throw new TypeError('Agreement source contains an undeclared sample for the selected target.');
    }
    const groups = groupsBySample.get(group.sampleId) ?? [];
    groups.push(group);
    groupsBySample.set(group.sampleId, groups);
  }
  const sampleById = new Map(samples.map((sample) => [sample.sampleId, sample]));
  return parameters.sampleIds.map((sampleId) => {
    if (signal?.aborted === true) throw signal.reason;
    const sample = sampleById.get(sampleId);
    if (sample === undefined) throw new TypeError('Agreement sample is absent from the Analysis plan.');
    const groups = [...(groupsBySample.get(sampleId) ?? [])].sort((left, right) => (
      left.trialIndex - right.trialIndex
    ));
    return {
      sampleId,
      gold: goldRating(sample, parameters),
      judge: judgeRating(groups),
    };
  });
}
