import type { SchemaIdentity } from '../../../eval-core/contracts/index.js';
import {
  ASSERTION_LAYER_TABLE_SCHEMA,
  parseAssertionLayerTableEnvelope,
} from './assertion-layer.js';
import type { CompositeLayerParameter } from './composite-parameters.js';
import type { CompositeGroup, CompositeLayerEntry } from './composite-table.js';
import {
  DIMENSION_TABLE_SCHEMA,
  parseDimensionTableEnvelope,
} from './dimension-table.js';
import {
  JUDGE_ENSEMBLE_TABLE_SCHEMA,
  parseJudgeEnsembleTableEnvelope,
} from './judge-aggregation.js';

export type CompositeSourceLayerGroup = Readonly<Pick<CompositeGroup,
  'targetId' | 'sampleId' | 'trialIndex' | 'trialId' | 'samplingUnitIds'
> & { layer: CompositeLayerEntry }>;

export const COMPOSITE_SOURCE_SCHEMAS = Object.freeze([
  ASSERTION_LAYER_TABLE_SCHEMA,
  DIMENSION_TABLE_SCHEMA,
  JUDGE_ENSEMBLE_TABLE_SCHEMA,
]);

export function compositeSourceSchema(
  binding: CompositeLayerParameter,
): SchemaIdentity {
  switch (binding.sourceKind) {
    case 'assertion-layer': return ASSERTION_LAYER_TABLE_SCHEMA;
    case 'judge-ensemble': return JUDGE_ENSEMBLE_TABLE_SCHEMA;
    case 'dimension': return DIMENSION_TABLE_SCHEMA;
  }
}

function sourceGroup(
  group: Pick<CompositeGroup,
    'targetId' | 'sampleId' | 'trialIndex' | 'trialId' | 'samplingUnitIds'
  >,
  layer: CompositeLayerEntry,
): CompositeSourceLayerGroup {
  return {
    targetId: group.targetId,
    sampleId: group.sampleId,
    trialIndex: group.trialIndex,
    trialId: group.trialId,
    samplingUnitIds: group.samplingUnitIds,
    layer,
  };
}

export function extractCompositeSourceLayers(
  binding: CompositeLayerParameter,
  envelope: unknown,
  signal?: AbortSignal,
): readonly CompositeSourceLayerGroup[] {
  switch (binding.sourceKind) {
    case 'assertion-layer':
      return parseAssertionLayerTableEnvelope(envelope).value.groups.map((group) => {
        if (signal?.aborted === true) throw signal.reason;
        const aggregate = group.layers[binding.selector];
        const common = { binding, sourceGroupId: group.groupId } as const;
        const layer: CompositeLayerEntry = aggregate.layerStatus === 'observed'
          ? { ...common, layerStatus: 'observed', score: aggregate.score }
          : { ...common, layerStatus: 'missing', reasonCode: aggregate.reasonCode };
        return sourceGroup(group, layer);
      });
    case 'judge-ensemble':
      return parseJudgeEnsembleTableEnvelope(envelope).value.groups.map((group) => {
        if (signal?.aborted === true) throw signal.reason;
        const common = { binding, sourceGroupId: group.groupId } as const;
        const layer: CompositeLayerEntry = group.aggregateStatus === 'observed'
          ? { ...common, layerStatus: 'observed', score: group.consensus }
          : { ...common, layerStatus: 'missing', reasonCode: group.reasonCode };
        return sourceGroup(group, layer);
      });
    case 'dimension':
      return parseDimensionTableEnvelope(envelope).value.groups.map((group) => {
        if (signal?.aborted === true) throw signal.reason;
        const common = { binding, sourceGroupId: group.groupId } as const;
        const layer: CompositeLayerEntry = group.aggregate.aggregateStatus === 'observed'
          ? { ...common, layerStatus: 'observed', score: group.aggregate.weightedMean }
          : { ...common, layerStatus: 'missing', reasonCode: group.aggregate.reasonCode };
        return sourceGroup(group, layer);
      });
  }
}
