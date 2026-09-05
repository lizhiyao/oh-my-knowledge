import { describe, expect, it } from 'vitest';
import {
  schemaIdentityKey,
} from '../../../src/eval-core/contracts/index.js';
import {
  ASSERTION_LAYER_PARAMETERS_SCHEMA,
  createAssertionLayerParameterSchemaValidators,
  parseAssertionLayerParameters,
} from '../../../src/eval-workflows/measurement/analysis/assertion-layer-parameters.js';

const fact = {
  criterionId: 'fact-a',
  metricId: 'metric-z',
  layerDisposition: 'fact',
  weight: 2,
} as const;
const behavior = {
  criterionId: 'behavior-a',
  metricId: 'metric-a',
  layerDisposition: 'behavior',
  weight: 1,
} as const;
const mixed = {
  criterionId: 'mixed-a',
  metricId: 'metric-m',
  layerDisposition: 'excluded-mixed-layer',
  weight: 4,
} as const;

describe('assertion-layer parameter contract', () => {
  it('normalizes criterion order into one sealed representation', () => {
    const expected = { criteria: [behavior, mixed, fact] };
    expect(parseAssertionLayerParameters({ criteria: [fact, behavior, mixed] })).toEqual(expected);
    expect(parseAssertionLayerParameters({ criteria: [mixed, fact, behavior] })).toEqual(expected);
  });

  it.each([
    {
      criteria: [fact, { ...behavior, criterionId: fact.criterionId }],
    },
    {
      criteria: [fact, { ...behavior, metricId: fact.metricId }],
    },
  ])('rejects ambiguous criterion or metric identities', (parameters) => {
    expect(() => parseAssertionLayerParameters(parameters)).toThrow();
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects non-positive or non-finite weight %s',
    (weight) => {
      expect(() => parseAssertionLayerParameters({
        criteria: [{ ...fact, weight }],
      })).toThrow();
    },
  );

  it('rejects empty criteria, implicit layer inference, and unknown fields', () => {
    expect(() => parseAssertionLayerParameters({ criteria: [] })).toThrow();
    expect(() => parseAssertionLayerParameters({
      criteria: [{ criterionId: 'a', metricId: 'm', weight: 1 }],
    })).toThrow();
    expect(() => parseAssertionLayerParameters({
      criteria: [{ ...fact, inferredFrom: 'assertion-type' }],
    })).toThrow();
  });

  it('registers a validator whose output is the canonical plan materialization', () => {
    const validator = createAssertionLayerParameterSchemaValidators().get(
      schemaIdentityKey(ASSERTION_LAYER_PARAMETERS_SCHEMA),
    );
    expect(validator).toBeDefined();
    expect(validator?.parse({ criteria: [fact, behavior, mixed] })).toEqual({
      criteria: [behavior, mixed, fact],
    });
    expect(validator?.schema.schemaVersion).toBe('omk.parameters.assertion-layer/v1');
    expect(validator?.schema.schemaUri).toBe('urn:omk:parameters:assertion-layer:v1');
  });
});

