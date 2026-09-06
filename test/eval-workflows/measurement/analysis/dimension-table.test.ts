import { describe, expect, it } from 'vitest';
import {
  digestCanonicalJson,
  schemaIdentityKey,
} from '../../../../src/eval-core/contracts/index.js';
import {
  DIMENSION_TABLE_SCHEMA,
  DIMENSION_TABLE_SCHEMA_VERSION,
  createDimensionTableSchemaValidators,
  dimensionAggregate,
  dimensionCoverage,
  dimensionGroupId,
  type DimensionEntry,
  type DimensionGroup,
  type DimensionTableValue,
} from '../../../../src/eval-workflows/measurement/analysis/dimension-table.js';

const trialId = digestCanonicalJson('dimension-trial');
const securitySource = digestCanonicalJson('security-source');
const actionabilitySource = digestCanonicalJson('actionability-source');

const security: DimensionEntry = {
  dimensionId: 'security',
  metricId: 'rubric-security',
  sourceAnalysisResultId: 'ensemble-security',
  sourceGroupId: securitySource,
  weight: 0.75,
  dimensionStatus: 'observed',
  consensus: 5,
};

const actionability: DimensionEntry = {
  dimensionId: 'actionability',
  metricId: 'rubric-actionability',
  sourceAnalysisResultId: 'ensemble-actionability',
  sourceGroupId: actionabilitySource,
  weight: 0.25,
  dimensionStatus: 'observed',
  consensus: 3,
};

function group(input: {
  sampleId?: string;
  dimensions?: DimensionEntry[];
  samplingUnitIds?: Record<string, string>;
} = {}): DimensionGroup {
  const dimensions = input.dimensions ?? [actionability, security];
  const value = {
    targetId: 'candidate',
    sampleId: input.sampleId ?? 'sample-a',
    trialIndex: 0,
    trialId,
    samplingUnitIds: input.samplingUnitIds ?? { pairingBlockId: digestCanonicalJson('pair-a') },
    dimensions,
    coverage: dimensionCoverage(dimensions),
    aggregate: dimensionAggregate(dimensions),
  };
  return { ...value, groupId: dimensionGroupId(value) };
}

function envelope(groups: DimensionGroup[] = [group()]) {
  return {
    resultType: 'table' as const,
    value: {
      schemaVersion: DIMENSION_TABLE_SCHEMA_VERSION,
      groups,
    } satisfies DimensionTableValue,
  };
}

function validator() {
  const candidate = createDimensionTableSchemaValidators().get(
    schemaIdentityKey(DIMENSION_TABLE_SCHEMA),
  );
  if (candidate === undefined) throw new Error('missing dimension table validator');
  return candidate;
}

describe('dimension table contract', () => {
  it('uses sealed rubric weights while retaining every source dimension', () => {
    const value = group();
    expect(value.aggregate).toEqual({ aggregateStatus: 'observed', weightedMean: 4.5 });
    expect(value.coverage).toEqual({
      plannedDimensions: 2,
      observedDimensions: 2,
      missingDimensions: 0,
    });
    expect(() => validator().parse(envelope([value]))).not.toThrow();
  });

  it('fails closed when any planned dimension is missing', () => {
    const missing: DimensionEntry = {
      dimensionId: security.dimensionId,
      metricId: security.metricId,
      sourceAnalysisResultId: security.sourceAnalysisResultId,
      sourceGroupId: security.sourceGroupId,
      weight: security.weight,
      dimensionStatus: 'missing',
      reasonCode: 'judge-ensemble-unobserved',
    };
    expect(dimensionAggregate([actionability, missing])).toEqual({
      aggregateStatus: 'missing',
      reasonCode: 'dimension-unobserved',
    });
    expect(dimensionAggregate([missing])).toEqual({
      aggregateStatus: 'missing',
      reasonCode: 'dimension-unobserved',
    });
  });

  it('accepts different applicable dimension sets across measurement units', () => {
    const first = group();
    const secondActionability = {
      ...actionability,
      sourceGroupId: digestCanonicalJson('actionability-source-b'),
    };
    const second = group({
      sampleId: 'sample-b',
      dimensions: [secondActionability],
      samplingUnitIds: { pairingBlockId: digestCanonicalJson('pair-b') },
    });
    expect(() => validator().parse(envelope([first, second]))).not.toThrow();
  });

  it.each([
    ['weighted mean', (candidate: ReturnType<typeof envelope>) => {
      const aggregate = candidate.value.groups[0].aggregate;
      if (aggregate.aggregateStatus === 'observed') aggregate.weightedMean = 4;
    }],
    ['coverage', (candidate: ReturnType<typeof envelope>) => {
      candidate.value.groups[0].coverage.missingDimensions = 1;
    }],
    ['source precision', (candidate: ReturnType<typeof envelope>) => {
      const entry = candidate.value.groups[0].dimensions[0];
      if (entry.dimensionStatus === 'observed') entry.consensus = 3.333;
    }],
    ['group identity', (candidate: ReturnType<typeof envelope>) => {
      candidate.value.groups[0].groupId = digestCanonicalJson('forged');
    }],
    ['entry order', (candidate: ReturnType<typeof envelope>) => {
      candidate.value.groups[0].dimensions.reverse();
    }],
  ])('rejects forged %s', (_name, mutate) => {
    const candidate = structuredClone(envelope());
    mutate(candidate);
    expect(() => validator().parse(candidate)).toThrow();
  });

  it('rejects unstable bindings, duplicate source lineage, and non-canonical group order', () => {
    const first = group();
    const unstable = group({
      sampleId: 'sample-b',
      dimensions: [{
        ...actionability,
        metricId: 'rubric-actionability-v2',
        sourceGroupId: digestCanonicalJson('actionability-source-b'),
      }],
      samplingUnitIds: { pairingBlockId: digestCanonicalJson('pair-b') },
    });
    expect(() => validator().parse(envelope([first, unstable]))).toThrow();

    const duplicateSource = group({
      sampleId: 'sample-b',
      dimensions: [actionability],
      samplingUnitIds: { pairingBlockId: digestCanonicalJson('pair-b') },
    });
    expect(() => validator().parse(envelope([first, duplicateSource]))).toThrow();

    const later = group({
      sampleId: 'sample-z',
      dimensions: [{
        ...actionability,
        sourceGroupId: digestCanonicalJson('actionability-source-z'),
      }],
      samplingUnitIds: { pairingBlockId: digestCanonicalJson('pair-z') },
    });
    expect(() => validator().parse(envelope([later, first]))).toThrow();
  });

  it('uses a strict versioned schema and rejects raw judge payloads', () => {
    const candidate = envelope() as ReturnType<typeof envelope> & {
      value: { groups: Array<DimensionGroup & { judgeReason?: string }> };
    };
    candidate.value.groups[0].judgeReason = 'private reasoning';
    expect(() => validator().parse(candidate)).toThrow();
    expect(validator().schema.schemaVersion).toBe('omk.dimension-table/v2');
    expect(validator().schema.schemaUri).toBe('urn:omk:analysis-result:dimension-table:v2');
  });
});
