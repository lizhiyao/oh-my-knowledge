import type { SchemaIdentity } from '../../../evaluation-core/contracts/index.js';
import {
  COMPOSITE_TABLE_SCHEMA,
  parseCompositeTableEnvelope,
} from './composite-table.js';
import type { BootstrapObservation } from './bootstrap-family-table.js';

export const BOOTSTRAP_FAMILY_SOURCE_SCHEMAS = Object.freeze([
  COMPOSITE_TABLE_SCHEMA,
]);

export function bootstrapFamilySourceSchema(): SchemaIdentity {
  return COMPOSITE_TABLE_SCHEMA;
}

export function extractBootstrapObservations(
  envelope: unknown,
  signal?: AbortSignal,
): readonly BootstrapObservation[] {
  return parseCompositeTableEnvelope(envelope).value.groups.map((group) => {
    if (signal?.aborted === true) throw signal.reason;
    const common = {
      sourceGroupId: group.groupId,
      targetId: group.targetId,
      sampleId: group.sampleId,
      trialIndex: group.trialIndex,
      trialId: group.trialId,
      samplingUnitIds: group.samplingUnitIds,
    } as const;
    return group.aggregate.aggregateStatus === 'observed'
      ? { ...common, observationStatus: 'observed', score: group.aggregate.score }
      : {
        ...common,
        observationStatus: 'missing',
        reasonCode: group.aggregate.reasonCode,
      };
  });
}
