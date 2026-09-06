import { describe, expect, it } from 'vitest';
import { digestCanonicalJson, schemaIdentityKey } from '../../../src/eval-core/contracts/index.js';
import {
  COMPOSITE_TABLE_SCHEMA,
  COMPOSITE_TABLE_SCHEMA_VERSION,
  compositeAggregate,
  compositeCoverage,
  compositeGroupId,
  createCompositeTableSchemaValidators,
  type CompositeGroup,
  type CompositeLayerEntry,
  type CompositeTableValue,
} from '../../../src/eval-workflows/measurement/analysis/composite-table.js';

const assertionSource = digestCanonicalJson('assertion-source');
const judgeSource = digestCanonicalJson('judge-source');
const trialId = digestCanonicalJson('composite-trial');

const fact: CompositeLayerEntry = {
  binding: {
    layerId: 'fact', analysisResultId: 'assertion-layers',
    sourceKind: 'assertion-layer', selector: 'fact',
  },
  sourceGroupId: assertionSource,
  layerStatus: 'observed',
  score: 3.29,
};
const behavior: CompositeLayerEntry = {
  binding: {
    layerId: 'behavior', analysisResultId: 'assertion-layers',
    sourceKind: 'assertion-layer', selector: 'behavior',
  },
  sourceGroupId: assertionSource,
  layerStatus: 'observed',
  score: 5,
};
const judge: CompositeLayerEntry = {
  binding: {
    layerId: 'judge', analysisResultId: 'dimension-table',
    sourceKind: 'dimension', selector: 'aggregate',
  },
  sourceGroupId: judgeSource,
  layerStatus: 'observed',
  score: 4,
};

function group(input: { sampleId?: string; layers?: CompositeLayerEntry[] } = {}): CompositeGroup {
  const layers = input.layers ?? [fact, behavior, judge];
  const value = {
    targetId: 'candidate',
    sampleId: input.sampleId ?? 'sample-a',
    trialIndex: 0,
    trialId,
    samplingUnitIds: { pairingBlockId: digestCanonicalJson(input.sampleId ?? 'sample-a') },
    layers,
    coverage: compositeCoverage(layers),
    aggregate: compositeAggregate(layers),
  };
  return { ...value, groupId: compositeGroupId(value) };
}

function envelope(groups: CompositeGroup[] = [group()]) {
  return {
    resultType: 'table' as const,
    value: {
      schemaVersion: COMPOSITE_TABLE_SCHEMA_VERSION,
      groups,
    } satisfies CompositeTableValue,
  };
}

function validator() {
  const candidate = createCompositeTableSchemaValidators().get(
    schemaIdentityKey(COMPOSITE_TABLE_SCHEMA),
  );
  if (candidate === undefined) throw new Error('missing composite table validator');
  return candidate;
}

describe('composite table contract', () => {
  it('reproduces the frozen fact + behavior + judge composite exactly', () => {
    const value = group();
    expect(value.aggregate).toEqual({ aggregateStatus: 'observed', score: 4.1 });
    expect(value.coverage).toEqual({ plannedLayers: 3, observedLayers: 3, missingLayers: 0 });
    expect(() => validator().parse(envelope([value]))).not.toThrow();
  });

  it('excludes missing layers and preserves all-missing without a zero score', () => {
    const missingJudge: CompositeLayerEntry = {
      binding: judge.binding,
      sourceGroupId: judge.sourceGroupId,
      layerStatus: 'missing',
      reasonCode: 'dimension-unobserved',
    };
    expect(compositeAggregate([fact, missingJudge])).toEqual({
      aggregateStatus: 'observed', score: 3.29,
    });
    expect(compositeAggregate([missingJudge])).toEqual({
      aggregateStatus: 'missing', reasonCode: 'composite-unobserved',
    });
  });

  it('keeps equal-mean semantics for two layers, one layer, and input order', () => {
    expect(compositeAggregate([
      { ...fact, score: 3 },
      behavior,
    ])).toEqual({ aggregateStatus: 'observed', score: 4 });
    expect(compositeAggregate([behavior])).toEqual({ aggregateStatus: 'observed', score: 5 });
    expect(compositeAggregate([judge])).toEqual({ aggregateStatus: 'observed', score: 4 });
    expect(compositeAggregate([judge, behavior, fact])).toEqual(
      compositeAggregate([fact, behavior, judge]),
    );
  });

  it('accepts different structurally applicable layer sets across units', () => {
    const secondJudge = {
      ...judge,
      sourceGroupId: digestCanonicalJson('judge-source-b'),
    };
    expect(() => validator().parse(envelope([
      group(),
      group({ sampleId: 'sample-b', layers: [secondJudge] }),
    ]))).not.toThrow();
  });

  it.each([
    ['score', (candidate: ReturnType<typeof envelope>) => {
      const aggregate = candidate.value.groups[0].aggregate;
      if (aggregate.aggregateStatus === 'observed') aggregate.score = 4.5;
    }],
    ['source precision', (candidate: ReturnType<typeof envelope>) => {
      const entry = candidate.value.groups[0].layers[0];
      if (entry.layerStatus === 'observed') entry.score = 3.291;
    }],
    ['coverage', (candidate: ReturnType<typeof envelope>) => {
      candidate.value.groups[0].coverage.missingLayers = 1;
    }],
    ['group identity', (candidate: ReturnType<typeof envelope>) => {
      candidate.value.groups[0].groupId = digestCanonicalJson('forged');
    }],
    ['layer order', (candidate: ReturnType<typeof envelope>) => {
      candidate.value.groups[0].layers.reverse();
    }],
    ['missing reason', (candidate: ReturnType<typeof envelope>) => {
      const entry = candidate.value.groups[0].layers[2];
      candidate.value.groups[0].layers[2] = {
        binding: entry.binding,
        sourceGroupId: entry.sourceGroupId,
        layerStatus: 'missing',
        reasonCode: 'assertion-layer-unobserved',
      };
      candidate.value.groups[0].coverage = compositeCoverage(candidate.value.groups[0].layers);
      candidate.value.groups[0].aggregate = compositeAggregate(candidate.value.groups[0].layers);
      candidate.value.groups[0].groupId = compositeGroupId(candidate.value.groups[0]);
    }],
  ])('rejects forged %s', (_name, mutate) => {
    const candidate = structuredClone(envelope());
    mutate(candidate);
    expect(() => validator().parse(candidate)).toThrow();
  });

  it('rejects unstable bindings, duplicate source selectors, and raw payloads', () => {
    const unstableJudge: CompositeLayerEntry = {
      ...judge,
      binding: { ...judge.binding, analysisResultId: 'dimension-table-v2' },
      sourceGroupId: digestCanonicalJson('judge-source-b'),
    };
    expect(() => validator().parse(envelope([
      group(),
      group({ sampleId: 'sample-b', layers: [unstableJudge] }),
    ]))).toThrow('binding must remain stable');

    const duplicate = group({ sampleId: 'sample-b', layers: [judge] });
    expect(() => validator().parse(envelope([group(), duplicate]))).toThrow(
      'selector lineage must be globally unique',
    );

    const later = group({
      sampleId: 'sample-z',
      layers: [{ ...judge, sourceGroupId: digestCanonicalJson('judge-source-z') }],
    });
    expect(() => validator().parse(envelope([later, group()]))).toThrow(
      'canonically ordered',
    );

    const raw = envelope() as ReturnType<typeof envelope> & {
      value: { groups: Array<CompositeGroup & { judgeReason?: string }> };
    };
    raw.value.groups[0].judgeReason = 'private';
    expect(() => validator().parse(raw)).toThrow();
  });
});
