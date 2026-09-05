import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import _Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  COMPARABILITY_ASSESSMENT_SCHEMA_VERSION,
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  EXECUTION_FACTS_SCHEMA_VERSION,
  EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
  EvaluationDefinitionSchema,
  EvaluationStatusSchema,
  MetricObservationSchema,
  RuntimeIdentitySchema,
  SERIES_ANALYSIS_BUNDLE_SCHEMA_VERSION,
  WIRE_SCHEMA_CATALOG,
  canonicalizeJson,
  generateWireJsonSchemas,
  generateRunContractSchemaIdentities,
  generateWireSchemaIdentities,
  parseWireDocument,
  wireSchemaCatalogVersion,
} from '../../../src/eval-core/contracts/index.js';
import {
  EVALUATION_CORE_JSON_SCHEMA_FILES,
  evaluationCoreJsonSchemaLocation,
  type EvaluationCoreJsonSchemaFile,
} from '../../../src/eval-core/schemas.js';

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;

describe('Evaluation Core wire schemas', () => {
  it('exports every catalog entry as deterministic JSON Schema 2020-12', () => {
    const generated = generateWireJsonSchemas();
    const schemaCatalogPath = 'schemas/eval-core';
    const schemaDir = resolve(schemaCatalogPath);
    const stableIdentityBase =
      `https://raw.githubusercontent.com/lizhiyao/oh-my-knowledge/main/${schemaCatalogPath}`;

    expect(WIRE_SCHEMA_CATALOG).toHaveLength(21);
    expect(EVALUATION_CORE_JSON_SCHEMA_FILES).toEqual(Object.keys(generated).sort());
    for (const entry of WIRE_SCHEMA_CATALOG) {
      const { fileName } = entry;
      const schema = generated[fileName];
      const catalogVersion = wireSchemaCatalogVersion(entry);
      expect(schema).toMatchObject({
        $id: `${stableIdentityBase}/${catalogVersion}/${fileName}`,
        $schema: 'https://json-schema.org/draft/2020-12/schema',
      });
      expect(evaluationCoreJsonSchemaLocation(fileName as EvaluationCoreJsonSchemaFile)).toBe(
        `${catalogVersion}/${fileName}`,
      );
      expect(JSON.parse(readFileSync(resolve(schemaDir, catalogVersion, fileName), 'utf8')))
        .toEqual(schema);
      expect(canonicalizeJson(schema)).not.toContain(':{}');
    }
  });

  it('compiles every generated schema with a JSON Schema 2020-12 validator', () => {
    for (const schema of Object.values(generateWireJsonSchemas())) {
      const ajv = new Ajv2020({ strict: false });
      expect(() => ajv.compile(schema as object)).not.toThrow();
    }
  });

  it('keeps active schema titles aligned with their public version identities', () => {
    const generated = generateWireJsonSchemas();
    expect(generated['evaluation-definition.schema.json']).toMatchObject({
      title: 'OMK Evaluation Definition v5',
    });
    expect(generated['execution-plan.schema.json']).toMatchObject({
      title: 'OMK Execution Plan v4',
    });
    expect(generated['run-plan.schema.json']).toMatchObject({ title: 'OMK Run Plan v5' });
  });

  it('derives full schema identities from generated schema bytes', () => {
    const identities = generateWireSchemaIdentities();
    expect(identities).toHaveLength(WIRE_SCHEMA_CATALOG.length);
    expect(new Set(identities.map((identity) => identity.schemaVersion)).size).toBe(identities.length);
    expect(identities.every((identity) => /^sha256:[0-9a-f]{64}$/.test(identity.schemaDigest))).toBe(true);
  });

  it('keeps post-hoc comparability schemas outside sealed Run identity', () => {
    const versions = generateRunContractSchemaIdentities().map(
      (identity) => identity.schemaVersion,
    );
    expect(versions).not.toContain('omk.comparability-policy/v1');
    expect(versions).not.toContain(COMPARABILITY_ASSESSMENT_SCHEMA_VERSION);
    expect(versions).toContain(EXECUTOR_CAPABILITIES_SCHEMA_VERSION);
    expect(versions).toContain(EXECUTION_FACTS_SCHEMA_VERSION);
  });

  it('publishes renamed comparability contracts under v2 without rewriting v1 roots', () => {
    expect(COMPARABILITY_ASSESSMENT_SCHEMA_VERSION).toBe('omk.comparability-assessment/v2');
    expect(SERIES_ANALYSIS_BUNDLE_SCHEMA_VERSION).toBe('omk.series-analysis-bundle/v2');
    expect(evaluationCoreJsonSchemaLocation('comparability-assessment.schema.json')).toBe(
      'v2/comparability-assessment.schema.json',
    );
    expect(evaluationCoreJsonSchemaLocation('series-analysis-bundle.schema.json')).toBe(
      'v2/series-analysis-bundle.schema.json',
    );
    expect(readFileSync(
      resolve('schemas/eval-core/v1/comparability-assessment.schema.json'),
      'utf8',
    )).toContain('"const": "omk.comparability-assessment/v1"');
    expect(readFileSync(
      resolve('schemas/eval-core/v1/series-analysis-bundle.schema.json'),
      'utf8',
    )).toContain('"const": "omk.series-analysis-bundle/v1"');
  });

  it('keeps opaque Runtime fingerprints distinct from OMK content digests', () => {
    expect(RuntimeIdentitySchema.parse({
      implementationId: 'remote-model',
      fingerprint: 'provider-deployment:2026-08-28',
      fingerprintBasis: 'opaque',
      assuranceLevel: 'declared',
      capabilities: {},
      implementationManifest: {
        coverageKind: 'fingerprint-plus-facets',
        facets: [{
          facetId: 'deployment',
          value: 'provider-deployment:2026-08-28',
        }],
      },
    }).fingerprint).toBe('provider-deployment:2026-08-28');
  });

  it('requires complete and unambiguous Runtime implementation facet coverage', () => {
    const base = {
      implementationId: 'remote-model',
      fingerprint: 'provider-deployment:2026-08-28',
      fingerprintBasis: 'self-reported' as const,
      assuranceLevel: 'declared' as const,
      capabilities: {},
    };

    expect(() => RuntimeIdentitySchema.parse(base)).toThrow();
    expect(() => RuntimeIdentitySchema.parse({
      ...base,
      implementationManifest: { coverageKind: 'fingerprint-complete' },
      implementationFacets: { deployment: 'primary' },
    })).toThrow();
    expect(() => RuntimeIdentitySchema.parse({
      ...base,
      implementationManifest: {
        coverageKind: 'fingerprint-plus-facets',
        facets: [
          { facetId: 'tools', value: 'v1' },
          { facetId: 'deployment', value: 'primary' },
        ],
      },
    })).toThrow();
    expect(() => RuntimeIdentitySchema.parse({
      ...base,
      implementationManifest: { coverageKind: 'fingerprint-complete' },
      provenanceFacets: { deployment: 'hidden-behavior-change' },
    })).toThrow();
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
        executionRequirements: {
          systemInstructions: 'not-required',
          workspace: 'not-required',
          mcp: 'not-required',
          mockInterception: 'not-required',
          toolPolicy: 'runtime-default',
          skillDiscovery: 'runtime-default',
        },
        executionControls: {
          defaults: {
            workspace: { workspaceMode: 'not-required' },
            tools: { toolPolicyKind: 'runtime-default' },
            mcp: { mcpMode: 'not-required' },
            mockInterception: { mockInterceptionMode: 'not-required' },
          },
          sampleOverrides: [],
        },
      }],
      evaluators: [],
      metrics: [],
      experiment: {
        trials: 1,
        seed: 'seed',
        assignment: {
          assignmentKind: 'complete-block',
          algorithmId: 'assignment.complete-block/v1',
          randomizationSlotIds: ['slot-t'],
        },
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
        executionRequirements: {
          systemInstructions: 'not-required',
          workspace: 'not-required',
          mcp: 'not-required',
          mockInterception: 'not-required',
          toolPolicy: 'runtime-default',
          skillDiscovery: 'runtime-default',
        },
        executionControls: {
          defaults: {
            workspace: { workspaceMode: 'not-required' },
            tools: { toolPolicyKind: 'runtime-default' },
            mcp: { mcpMode: 'not-required' },
            mockInterception: { mockInterceptionMode: 'not-required' },
          },
          sampleOverrides: [],
        },
      }],
      evaluators: [],
      metrics: [],
      experiment: {
        trials: 1,
        seed: 'seed',
        assignment: {
          assignmentKind: 'complete-block',
          algorithmId: 'assignment.complete-block/v1',
          randomizationSlotIds: ['slot-t'],
        },
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
    expect(
      parsed.success,
      parsed.success ? undefined : JSON.stringify(parsed.error.issues),
    ).toBe(true);
  });
});
