import { describe, expect, it } from 'vitest';
import {
  schemaIdentityKey,
} from '../../../src/eval-core/contracts/index.js';
import {
  DIMENSION_PARAMETERS_SCHEMA,
  createDimensionParameterSchemaValidators,
  parseDimensionParameters,
} from '../../../src/eval-workflows/runtime-adapter/analysis/dimension-parameters.js';

const security = {
  dimensionId: 'security',
  metricId: 'rubric-security',
  analysisResultId: 'ensemble-security',
} as const;
const actionability = {
  dimensionId: 'actionability',
  metricId: 'rubric-actionability',
  analysisResultId: 'ensemble-actionability',
} as const;
const clarity = {
  dimensionId: 'clarity',
  metricId: 'rubric-clarity',
  analysisResultId: 'ensemble-clarity',
} as const;

describe('dimension parameter contract', () => {
  it('normalizes dimensions into one sealed upstream-result order', () => {
    const expected = { dimensions: [actionability, clarity, security] };
    expect(parseDimensionParameters({
      dimensions: [security, actionability, clarity],
    })).toEqual(expected);
    expect(parseDimensionParameters({
      dimensions: [clarity, security, actionability],
    })).toEqual(expected);
  });

  it.each([
    {
      dimensions: [security, { ...actionability, dimensionId: security.dimensionId }],
    },
    {
      dimensions: [security, { ...actionability, metricId: security.metricId }],
    },
    {
      dimensions: [
        security,
        { ...actionability, analysisResultId: security.analysisResultId },
      ],
    },
  ])('rejects ambiguous dimension, metric, or upstream result identities', (parameters) => {
    expect(() => parseDimensionParameters(parameters)).toThrow();
  });

  it('rejects empty dimensions, implicit bindings, invalid identifiers, and unknown fields', () => {
    expect(() => parseDimensionParameters({ dimensions: [] })).toThrow();
    expect(() => parseDimensionParameters({
      dimensions: [{ dimensionId: 'security', metricId: 'rubric-security' }],
    })).toThrow();
    expect(() => parseDimensionParameters({
      dimensions: [{ ...security, dimensionId: '' }],
    })).toThrow();
    expect(() => parseDimensionParameters({
      dimensions: [{ ...security, inferredFrom: 'rubric-name' }],
    })).toThrow();
  });

  it('registers a validator whose output is the canonical plan materialization', () => {
    const validator = createDimensionParameterSchemaValidators().get(
      schemaIdentityKey(DIMENSION_PARAMETERS_SCHEMA),
    );
    expect(validator).toBeDefined();
    expect(validator?.parse({
      dimensions: [security, actionability, clarity],
    })).toEqual({ dimensions: [actionability, clarity, security] });
    expect(validator?.schema.schemaVersion).toBe('omk.parameters.dimension/v1');
    expect(validator?.schema.schemaUri).toBe('urn:omk:parameters:dimension:v1');
  });
});
