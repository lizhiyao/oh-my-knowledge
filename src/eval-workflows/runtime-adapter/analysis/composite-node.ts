import {
  canonicalizeJson,
} from '../../../eval-core/contracts/index.js';
import type {
  AnalysisNodeImplementation,
} from '../../../eval-core/analysis/index.js';
import {
  parseCompositeParameters,
  type CompositeParameters,
} from './composite-parameters.js';
import {
  extractCompositeSourceLayers,
} from './composite-source-adapter.js';
import {
  COMPOSITE_TABLE_SCHEMA,
  COMPOSITE_TABLE_SCHEMA_VERSION,
  compareCompositeGroups,
  compareCompositeLayerEntries,
  compositeAggregate,
  compositeCoverage,
  compositeGroupId,
  parseCompositeTableEnvelope,
  type CompositeGroup,
  type CompositeLayerEntry,
  type CompositeTableValue,
} from './composite-table.js';
import {
  createStatelessAnalysisImplementation,
} from './analysis-support.js';
import {
  COMPOSITE_ANALYSIS_IDENTITY,
  COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
  compositeAnalysisResultInputs,
  validateCompositeInputDesign,
  type CompositeAnalysisResultInput,
} from './composite-node-contract.js';

export {
  COMPOSITE_ANALYSIS_IDENTITY,
  COMPOSITE_ANALYSIS_IMPLEMENTATION_ID,
} from './composite-node-contract.js';

function coordinateKey(group: Pick<CompositeGroup,
  'targetId' | 'sampleId' | 'trialIndex'
>): string {
  return canonicalizeJson([group.targetId, group.sampleId, group.trialIndex]);
}

interface PendingGroup {
  targetId: string;
  sampleId: string;
  trialIndex: number;
  trialId: CompositeGroup['trialId'];
  samplingUnitIds: CompositeGroup['samplingUnitIds'];
  layers: CompositeLayerEntry[];
}

function buildCompositeTable(
  inputs: readonly CompositeAnalysisResultInput[],
  parameters: CompositeParameters,
  signal: AbortSignal,
): CompositeTableValue {
  const bindingsByResult = validateCompositeInputDesign(inputs, parameters);
  const pending = new Map<string, PendingGroup>();
  for (const input of inputs) {
    const bindings = bindingsByResult.get(input.referenceId);
    if (bindings === undefined) throw new TypeError('Composite input is not explicitly bound.');
    const envelope = { resultType: input.record.resultType, value: input.record.value };
    for (const binding of bindings) {
      for (const source of extractCompositeSourceLayers(binding, envelope, signal)) {
        const key = coordinateKey(source);
        const existing = pending.get(key);
        if (existing === undefined) {
          const { layer, ...coordinates } = source;
          pending.set(key, { ...coordinates, layers: [layer] });
          continue;
        }
        if (existing.trialId !== source.trialId
            || canonicalizeJson(existing.samplingUnitIds)
              !== canonicalizeJson(source.samplingUnitIds)) {
          throw new TypeError('Upstream layers disagree on sealed measurement-unit lineage.');
        }
        if (existing.layers.some((entry) => (
          entry.binding.layerId === source.layer.binding.layerId
        ))) {
          throw new TypeError('A measurement unit contains duplicate upstream layer groups.');
        }
        existing.layers.push(source.layer);
      }
    }
  }
  const groups = [...pending.values()].map((source): CompositeGroup => {
    const layers = [...source.layers].sort(compareCompositeLayerEntries);
    const withoutGroupId: Omit<CompositeGroup, 'groupId'> = {
      ...source,
      layers,
      coverage: compositeCoverage(layers),
      aggregate: compositeAggregate(layers),
    };
    return { groupId: compositeGroupId(withoutGroupId), ...withoutGroupId };
  });
  groups.sort(compareCompositeGroups);
  return parseCompositeTableEnvelope({
    resultType: 'table',
    value: { schemaVersion: COMPOSITE_TABLE_SCHEMA_VERSION, groups },
  }).value;
}

export function createCompositeAnalysisNodes(): ReadonlyMap<
  string,
  AnalysisNodeImplementation
> {
  const implementation = createStatelessAnalysisImplementation({
    identity: COMPOSITE_ANALYSIS_IDENTITY,
    outputSchema: COMPOSITE_TABLE_SCHEMA,
    parseParameters: (parameters) => { parseCompositeParameters(parameters); },
    execute(context) {
      const parameters = parseCompositeParameters(context.node.parameters);
      const inputs = compositeAnalysisResultInputs(context.inputs);
      const table = buildCompositeTable(inputs, parameters, context.signal);
      return {
        analysisStatus: 'completed',
        resultType: 'table',
        value: table,
        includedRowIds: [],
        comparableRowIds: [],
        assumptionChecks: [{
          assumptionId: 'composite-contract',
          checkStatus: 'passed',
        }],
      };
    },
  });
  return new Map([[COMPOSITE_ANALYSIS_IMPLEMENTATION_ID, implementation]]);
}
