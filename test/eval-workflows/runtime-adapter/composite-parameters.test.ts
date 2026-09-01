import { describe, expect, it } from 'vitest';
import { schemaIdentityKey } from '../../../src/evaluation-core/contracts/index.js';
import {
  COMPOSITE_PARAMETERS_SCHEMA,
  createCompositeParameterSchemaValidators,
  parseCompositeParameters,
} from '../../../src/eval-workflows/runtime-adapter/analysis/composite-parameters.js';

const fact = {
  layerId: 'fact',
  analysisResultId: 'assertion-layers',
  sourceKind: 'assertion-layer',
  selector: 'fact',
} as const;
const behavior = {
  layerId: 'behavior',
  analysisResultId: 'assertion-layers',
  sourceKind: 'assertion-layer',
  selector: 'behavior',
} as const;
const dimensionJudge = {
  layerId: 'judge',
  analysisResultId: 'dimension-table',
  sourceKind: 'dimension',
  selector: 'aggregate',
} as const;
const ensembleJudge = {
  layerId: 'judge',
  analysisResultId: 'ensemble-table',
  sourceKind: 'judge-ensemble',
  selector: 'consensus',
} as const;

describe('composite parameter contract', () => {
  it('normalizes every valid layer combination into fact, behavior, judge order', () => {
    const expected = { layers: [fact, behavior, dimensionJudge] };
    expect(parseCompositeParameters({
      layers: [dimensionJudge, behavior, fact],
    })).toEqual(expected);
    expect(parseCompositeParameters({ layers: [fact] })).toEqual({ layers: [fact] });
    expect(parseCompositeParameters({ layers: [ensembleJudge] })).toEqual({
      layers: [ensembleJudge],
    });
  });

  it('rejects duplicate layers and independently configured fact/behavior sources', () => {
    expect(() => parseCompositeParameters({ layers: [fact, { ...fact }] })).toThrow();
    expect(() => parseCompositeParameters({
      layers: [fact, { ...behavior, analysisResultId: 'other-assertion-layers' }],
    })).toThrow('share one assertion-layer result');
    expect(() => parseCompositeParameters({
      layers: [dimensionJudge, ensembleJudge],
    })).toThrow();
    expect(() => parseCompositeParameters({
      layers: [fact, { ...dimensionJudge, analysisResultId: fact.analysisResultId }],
    })).toThrow('multiple source kinds');
  });

  it('rejects implicit selectors, invalid source combinations, empty designs, and unknown fields', () => {
    expect(() => parseCompositeParameters({ layers: [] })).toThrow();
    expect(() => parseCompositeParameters({
      layers: [{ layerId: 'fact', analysisResultId: 'assertion-layers' }],
    })).toThrow();
    expect(() => parseCompositeParameters({
      layers: [{ ...fact, selector: 'consensus' }],
    })).toThrow();
    expect(() => parseCompositeParameters({
      layers: [{ ...dimensionJudge, weight: 0.5 }],
    })).toThrow();
  });

  it('registers a validator whose output is the canonical plan materialization', () => {
    const validator = createCompositeParameterSchemaValidators().get(
      schemaIdentityKey(COMPOSITE_PARAMETERS_SCHEMA),
    );
    expect(validator).toBeDefined();
    expect(validator?.parse({ layers: [dimensionJudge, fact, behavior] })).toEqual({
      layers: [fact, behavior, dimensionJudge],
    });
    expect(validator?.schema.schemaVersion).toBe('omk.parameters.composite/v1');
    expect(validator?.schema.schemaUri).toBe('urn:omk:parameters:composite:v1');
  });
});
