import { resolveJsonPointer } from '../../../eval-core/primitives/json-pointer.js';
import type { AnalysisNodeExecutionContext } from '../../../eval-core/analysis/index.js';
import type { AgreementParameters } from './agreement-parameters.js';
import type { AgreementPair } from './agreement-table.js';


function resolvePointer(value: unknown, pointer: string): unknown {
  const result = resolveJsonPointer(value, pointer);
  return result.resolved ? result.value : undefined;
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

/** Pair already-validated groups; schema parsing and judge aggregation remain version-owned. */
export function extractAgreementPairsFromGroups<Group extends {
  targetId: string;
  sampleId: string;
  trialIndex: number;
}>(
  parameters: AgreementParameters,
  sourceGroups: readonly Group[],
  samples: AnalysisNodeExecutionContext['samples'],
  judgeRating: (groups: readonly Group[]) => AgreementPair['judge'],
  signal?: AbortSignal,
): readonly AgreementPair[] {
  const sampleSet = new Set(parameters.sampleIds);
  const groupsBySample = new Map<string, Group[]>();
  for (const group of sourceGroups) {
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
