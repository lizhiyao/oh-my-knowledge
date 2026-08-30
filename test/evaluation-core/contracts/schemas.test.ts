import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import _Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  EvaluationDefinitionSchema,
  EvaluationStatusSchema,
  MetricObservationSchema,
  RuntimeIdentitySchema,
  WIRE_SCHEMA_CATALOG,
  canonicalizeJson,
  generateWireJsonSchemas,
  generateWireSchemaIdentities,
  parseWireDocument,
} from '../../../src/evaluation-core/contracts/index.js';

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;

describe('Evaluation Core wire schemas', () => {
  it('exports every catalog entry as deterministic JSON Schema 2020-12', () => {
    const generated = generateWireJsonSchemas();
    const schemaDir = resolve('schemas/evaluation-core/v1');
    const files = readdirSync(schemaDir).filter((name) => name.endsWith('.schema.json')).sort();

    expect(files).toEqual(WIRE_SCHEMA_CATALOG.map((entry) => entry.fileName).sort());
    for (const [fileName, schema] of Object.entries(generated)) {
      expect(schema).toMatchObject({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
      });
      expect(JSON.parse(readFileSync(resolve(schemaDir, fileName), 'utf8'))).toEqual(schema);
      expect(canonicalizeJson(schema)).not.toContain(':{}');
    }
  });

  it('compiles every generated schema with a JSON Schema 2020-12 validator', () => {
    for (const schema of Object.values(generateWireJsonSchemas())) {
      const ajv = new Ajv2020({ strict: false });
      expect(() => ajv.compile(schema as object)).not.toThrow();
    }
  });

  it('derives full schema identities from generated schema bytes', () => {
    const identities = generateWireSchemaIdentities();
    expect(identities).toHaveLength(WIRE_SCHEMA_CATALOG.length);
    expect(new Set(identities.map((identity) => identity.schemaVersion)).size).toBe(identities.length);
    expect(identities.every((identity) => /^sha256:[0-9a-f]{64}$/.test(identity.schemaDigest))).toBe(true);
  });

  it('keeps opaque Runtime fingerprints distinct from OMK content digests', () => {
    expect(RuntimeIdentitySchema.parse({
      implementationId: 'remote-model',
      fingerprint: 'provider-deployment:2026-08-28',
      fingerprintBasis: 'opaque',
      assuranceLevel: 'declared',
      capabilities: {},
    }).fingerprint).toBe('provider-deployment:2026-08-28');
  });

  it('rejects unknown Definition fields and non-JSON values', () => {
    const base = {
      schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
      dataset: { datasetId: 'd', samples: [{ sampleId: 's', input: null }] },
      targets: [{
        targetId: 't',
        targetKind: 'function',
        protocolId: 'omk.invoke/v1',
        executorId: 'e',
      }],
      evaluators: [],
      metrics: [],
      experiment: {
        trials: 1,
        seed: 'seed',
        randomizationSlots: [{ targetId: 't', randomizationSlotId: 'slot-t' }],
        sampling: {
          experimentalUnit: 'sample',
          repeatedMeasures: false,
          resamplingUnit: 'sample',
          estimatorId: 'bootstrap.mean-percentile/v1',
          seedCoupling: 'independent-by-target',
        },
        scheduling: { schedulingKind: 'sequential' },
      },
      analysisGraph: { analysisMode: 'preregistered', nodes: [] },
      comparisons: [],
    };

    expect(EvaluationDefinitionSchema.safeParse({ ...base, typo: true }).success).toBe(false);
    expect(EvaluationDefinitionSchema.safeParse({
      ...base,
      dataset: { datasetId: 'd', samples: [{ sampleId: 's', input: () => null }] },
    }).success).toBe(false);
    const withAccessor = {
      ...base,
      dataset: { datasetId: 'd', samples: [{ sampleId: 's', input: {} }] },
    };
    Object.defineProperty(withAccessor.dataset.samples[0].input, 'hidden', {
      enumerable: true,
      get: () => 'effectful',
    });
    expect(() => parseWireDocument(EvaluationDefinitionSchema, withAccessor)).toThrow(
      /enumerable data properties/,
    );
  });

  it('keeps Metric values native and represents missing separately from zero', () => {
    expect(MetricObservationSchema.parse({
      observationId: `sha256:${'1'.repeat(64)}`,
      metricId: 'score',
      observationStatus: 'observed',
      valueType: 'numeric',
      value: 0,
    })).toMatchObject({ observationStatus: 'observed', value: 0 });
    expect(MetricObservationSchema.parse({
      observationId: `sha256:${'2'.repeat(64)}`,
      metricId: 'score',
      observationStatus: 'missing',
      valueType: 'numeric',
      reasonCode: 'evaluator-error',
    })).not.toHaveProperty('value');
  });

  it('allows all three status axes to vary independently', () => {
    expect(EvaluationStatusSchema.parse({
      runStatus: 'completed',
      evidenceStatus: 'partial',
      conclusionStatus: 'inconclusive',
    })).toEqual({
      runStatus: 'completed',
      evidenceStatus: 'partial',
      conclusionStatus: 'inconclusive',
    });
  });

  it('accepts only URI-namespaced extensions with declared schemas and digests', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const parsed = EvaluationDefinitionSchema.safeParse({
      schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
      dataset: { datasetId: 'd', samples: [{ sampleId: 's', input: null }] },
      targets: [{
        targetId: 't',
        targetKind: 'function',
        protocolId: 'omk.invoke/v1',
        executorId: 'e',
      }],
      evaluators: [],
      metrics: [],
      experiment: {
        trials: 1,
        seed: 'seed',
        randomizationSlots: [{ targetId: 't', randomizationSlotId: 'slot-t' }],
        sampling: {
          experimentalUnit: 'sample',
          repeatedMeasures: false,
          resamplingUnit: 'sample',
          estimatorId: 'bootstrap.mean-percentile/v1',
          seedCoupling: 'independent-by-target',
        },
        scheduling: { schedulingKind: 'sequential' },
      },
      analysisGraph: { analysisMode: 'preregistered', nodes: [] },
      comparisons: [],
      extensions: {
        'urn:example:attestation': {
          schemaUri: 'https://example.com/attestation.schema.json',
          schemaDigest: digest,
          data: { statement: 'opaque until a host verifies it' },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });
});
