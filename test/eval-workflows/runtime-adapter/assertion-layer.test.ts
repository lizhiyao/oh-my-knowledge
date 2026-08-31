import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  digestCanonicalJson,
  schemaIdentityKey,
  type JsonValue,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  ASSERTION_LAYER_TABLE_SCHEMA,
  ASSERTION_LAYER_TABLE_SCHEMA_VERSION,
  assertionLayerAggregate,
  assertionLayerCoverage,
  assertionLayerGroupId,
  createAssertionLayerTableSchemaValidators,
  type AssertionEntry,
  type AssertionLayerGroup,
} from '../../../src/eval-workflows/runtime-adapter/analysis/assertion-layer.js';

const TRIAL_ID = digestCanonicalJson({ fixture: 'assertion-layer-trial' });
const PAIRING_BLOCK_ID = digestCanonicalJson({ fixture: 'assertion-layer-pair' });

const scoringFixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../fixtures/evaluation-core/scoring-equivalence-v1.json',
  import.meta.url,
)), 'utf8')) as {
  deterministicAssertions: {
    expectedLayered: { layeredScores: { factScore: number; behaviorScore: number } };
  };
};

function observed(input: Readonly<{
  criterionId: string;
  metricId: string;
  layerDisposition: AssertionEntry['layerDisposition'];
  weight: number;
  value: boolean;
}>): AssertionEntry {
  return {
    ...input,
    rowId: digestCanonicalJson({ row: input.criterionId }),
    evaluatorId: `evaluator-${input.criterionId}`,
    censored: false,
    applicability: 'applicable',
    rowStatus: 'observed',
  };
}

const entries: AssertionEntry[] = [
  observed({ criterionId: 'contains-hello', metricId: 'assert-contains-hello', layerDisposition: 'fact', weight: 2, value: true }),
  observed({ criterionId: 'contains-missing', metricId: 'assert-contains-missing', layerDisposition: 'fact', weight: 3, value: false }),
  observed({ criterionId: 'fact-set', metricId: 'assert-fact-set', layerDisposition: 'fact', weight: 2, value: true }),
  observed({ criterionId: 'max-length', metricId: 'assert-max-length', layerDisposition: 'behavior', weight: 1, value: true }),
  observed({ criterionId: 'mixed-set', metricId: 'assert-mixed-set', layerDisposition: 'excluded-mixed-layer', weight: 4, value: true }),
];

function group(
  sourceEntries: readonly AssertionEntry[] = entries,
  sampleId = 'sample-a',
): AssertionLayerGroup {
  const fact = sourceEntries.filter((entry) => entry.layerDisposition === 'fact');
  const behavior = sourceEntries.filter((entry) => entry.layerDisposition === 'behavior');
  const excluded = sourceEntries.filter((entry) => entry.layerDisposition === 'excluded-mixed-layer');
  const withoutGroupId: Omit<AssertionLayerGroup, 'groupId'> = {
    targetId: 'target-a',
    sampleId,
    trialIndex: 0,
    trialId: TRIAL_ID,
    samplingUnitIds: { pairingBlockId: PAIRING_BLOCK_ID },
    entries: [...sourceEntries],
    layers: {
      fact: assertionLayerAggregate(fact),
      behavior: assertionLayerAggregate(behavior),
    },
    excludedMixedLayer: { coverage: assertionLayerCoverage(excluded) },
  };
  return { groupId: assertionLayerGroupId(withoutGroupId), ...withoutGroupId };
}

function envelope(sourceGroup: AssertionLayerGroup = group()): JsonValue {
  return {
    resultType: 'table',
    value: {
      schemaVersion: ASSERTION_LAYER_TABLE_SCHEMA_VERSION,
      groups: [sourceGroup],
    },
  };
}

function validator() {
  const candidate = createAssertionLayerTableSchemaValidators().get(
    schemaIdentityKey(ASSERTION_LAYER_TABLE_SCHEMA),
  );
  if (candidate === undefined) throw new Error('missing assertion-layer table validator');
  return candidate;
}

interface MutableEnvelope {
  value: {
    groups: Array<{
      samplingUnitIds: Record<string, string>;
      entries: Array<{
        weight: number;
        applicability: string;
        rowStatus: string;
        censored: boolean;
        reasonCode?: string;
        value?: boolean;
      }>;
      layers: { fact: { score: number; coverage: { passedWeight: number } } };
    }>;
  };
}

describe('assertion-layer table contract', () => {
  it('reproduces frozen layer scores while preserving mixed-layer evidence', () => {
    const result = group();
    expect(result.layers.fact).toMatchObject({
      layerStatus: 'observed',
      score: scoringFixture.deterministicAssertions.expectedLayered.layeredScores.factScore,
      coverage: { declaredCriteria: 3, observedWeight: 7, passedWeight: 4 },
    });
    expect(result.layers.behavior).toMatchObject({
      layerStatus: 'observed',
      score: scoringFixture.deterministicAssertions.expectedLayered.layeredScores.behaviorScore,
      coverage: { declaredCriteria: 1, observedWeight: 1, passedWeight: 1 },
    });
    expect(result.excludedMixedLayer.coverage).toMatchObject({
      declaredCriteria: 1,
      declaredWeight: 4,
      observedCriteria: 1,
      passedWeight: 4,
    });
    expect(() => validator().parse(envelope(result))).not.toThrow();
  });

  it('separates structural non-applicability from applicable missing evidence', () => {
    const source: AssertionEntry[] = [{
      criterionId: 'not-applicable',
      metricId: 'metric-a',
      layerDisposition: 'fact',
      weight: 2,
      rowId: digestCanonicalJson('not-applicable'),
      evaluatorId: 'evaluator-a',
      censored: false,
      applicability: 'not-applicable',
      rowStatus: 'missing',
      reasonCode: 'criterion-not-applicable',
    }, {
      criterionId: 'failed',
      metricId: 'metric-b',
      layerDisposition: 'fact',
      weight: 3,
      rowId: digestCanonicalJson('failed'),
      evaluatorId: 'evaluator-b',
      censored: true,
      applicability: 'applicable',
      rowStatus: 'evaluation-failed',
      reasonCode: 'provider-failed',
    }];
    const result = group(source);
    expect(result.layers.fact).toMatchObject({
      layerStatus: 'missing',
      reasonCode: 'assertion-layer-unobserved',
      coverage: {
        declaredCriteria: 2,
        declaredWeight: 5,
        notApplicableCriteria: 1,
        notApplicableWeight: 2,
        applicableCriteria: 1,
        plannedWeight: 3,
        evaluationFailedCriteria: 1,
        evaluationFailedWeight: 3,
        censoredCriteria: 1,
        censoredWeight: 3,
        observedWeight: 0,
      },
    });
    expect(() => validator().parse(envelope(result))).not.toThrow();
  });

  it('conserves every applicable non-observed status and its weight', () => {
    const statuses = [
      ['missing', 'missing'],
      ['invalid', 'invalid'],
      ['evaluation-failed', 'evaluationFailed'],
      ['source-unavailable', 'sourceUnavailable'],
      ['not-started', 'notStarted'],
    ] as const;
    const source = statuses.map(([rowStatus], index): AssertionEntry => ({
      criterionId: `criterion-${index}`,
      metricId: `metric-${index}`,
      layerDisposition: 'fact',
      weight: index + 1,
      rowId: digestCanonicalJson({ status: rowStatus }),
      evaluatorId: `evaluator-${index}`,
      censored: index === 4,
      applicability: 'applicable',
      rowStatus,
      reasonCode: `reason-${index}`,
    }));
    const coverage = assertionLayerCoverage(source);
    expect(coverage).toMatchObject({
      declaredCriteria: 5,
      declaredWeight: 15,
      applicableCriteria: 5,
      plannedWeight: 15,
      observedCriteria: 0,
      observedWeight: 0,
      censoredCriteria: 1,
      censoredWeight: 5,
    });
    for (const [, prefix] of statuses) {
      expect(coverage[`${prefix}Criteria`]).toBe(1);
    }
    expect(() => validator().parse(envelope(group(source)))).not.toThrow();
  });

  it('rejects score, coverage, ordering, design, and sampling-lineage tampering', () => {
    const valid = envelope();
    const mutations: Array<(candidate: MutableEnvelope) => void> = [
      (candidate) => { candidate.value.groups[0].layers.fact.score = 5; },
      (candidate) => { candidate.value.groups[0].layers.fact.coverage.passedWeight = 7; },
      (candidate) => { candidate.value.groups[0].entries.reverse(); },
      (candidate) => { candidate.value.groups[0].entries[0].weight = 99; },
      (candidate) => { candidate.value.groups[0].samplingUnitIds = {}; },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(valid) as unknown as MutableEnvelope;
      mutate(candidate);
      expect(() => validator().parse(candidate)).toThrow();
    }
  });

  it('rejects duplicate source row lineage across measurement groups', () => {
    const second = group(entries, 'sample-b');
    const candidate = envelope() as unknown as { value: { groups: AssertionLayerGroup[] } };
    candidate.value.groups.push(second);
    expect(() => validator().parse(candidate)).toThrow('source row identities');
  });

  it('rejects internally valid groups that disagree on the sealed criterion design', () => {
    const secondEntries = entries.map((entry): AssertionEntry => ({
      ...entry,
      rowId: digestCanonicalJson({ row: entry.criterionId, sampleId: 'sample-b' }),
      ...(entry.criterionId === 'contains-hello' ? { weight: 9 } : {}),
    }));
    const candidate = envelope() as unknown as { value: { groups: AssertionLayerGroup[] } };
    candidate.value.groups.push(group(secondEntries, 'sample-b'));
    expect(() => validator().parse(candidate)).toThrow('same sealed criterion design');
  });

  it('rejects a structurally not-applicable criterion marked as censored', () => {
    const candidate = structuredClone(envelope()) as unknown as MutableEnvelope;
    const entry = candidate.value.groups[0].entries[0];
    entry.applicability = 'not-applicable';
    entry.rowStatus = 'missing';
    entry.censored = true;
    entry.reasonCode = 'criterion-not-applicable';
    delete entry.value;
    expect(() => validator().parse(candidate)).toThrow();
  });

  it('publishes a strict, digest-bound v1 schema identity', () => {
    expect(ASSERTION_LAYER_TABLE_SCHEMA).toMatchObject({
      schemaVersion: 'omk.assertion-layer-table/v1',
      schemaUri: 'urn:omk:analysis-result:assertion-layer-table:v1',
    });
    expect(ASSERTION_LAYER_TABLE_SCHEMA.schemaDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() => validator().parse({
      ...(envelope() as Record<string, JsonValue>),
      unknown: true,
    })).toThrow();
  });
});
