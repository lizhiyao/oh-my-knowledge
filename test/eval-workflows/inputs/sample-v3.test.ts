import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../../../src/eval-core/contracts/index.js';
import { loadSamples } from '../../../src/eval-workflows/inputs/load-samples.js';
import { createWorkflowSampleSetDocument } from '../../../src/eval-workflows/inputs/schemas/sample-set.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function file(value: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'omk-v3-contract-')); roots.push(root);
  const path = join(root, 'samples.json'); writeFileSync(path, JSON.stringify(value)); return path;
}
const schemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:test:ticket:v1',
  type: 'object', required: ['enabled', 'count', 'label'], additionalProperties: false,
  properties: { enabled: { type: 'boolean' }, count: { type: 'number' }, label: { type: 'null' } },
};
const input = { inputKind: 'json', value: { enabled: false, count: 0, label: null },
  schema: { schemaVersion: 'test.ticket/v1', schemaUri: schemaDocument.$id,
    schemaDigest: digestCanonicalJson(schemaDocument) }, schemaDocument };
const document = { schemaVersion: 'omk.eval-sample-set/v3', samples: [{
  sampleId: 'ticket', input, executionContext: { data: { locale: 'zh' } },
  expected: { result: 'GOLD_SENTINEL' }, evaluationContext: {
    reference: 'EVALUATOR_ONLY', checks: [{ checkKind: 'exact-match', checkId: 'result',
      actual: { sourceKind: 'output', pointer: '/result' }, expectedPointer: '/result', layer: 'fact' }],
  }, annotations: { provenance: 'human', difficulty: 'easy' },
}] };

describe('v3 public sample contract', () => {
  it('round-trips typed values and keeps execution, gold and annotations separate', () => {
    const loaded = loadSamples(file(document));
    expect(createWorkflowSampleSetDocument(loaded.samples)).toEqual(document);
    expect(loaded.samples[0].input).toEqual(input);
    expect(JSON.stringify(loaded.samples[0].input)).not.toContain('GOLD_SENTINEL');
    expect(JSON.stringify(loaded.samples[0].executionData)).not.toContain('EVALUATOR_ONLY');
  });
  it('rejects v2 without changing the user file', () => {
    const path = file({ schemaVersion: 'omk.eval-sample-set/v2', samples: [{ sample_id: 'old', prompt: 'Keep me.' }] });
    const before = readFileSync(path, 'utf8');
    expect(() => loadSamples(path)).toThrow(/Unsupported sample schema.*v2/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it.each([
    { ...input, value: { enabled: 'false', count: 0, label: null } },
    { ...input, schema: { ...input.schema, schemaDigest: `sha256:${'0'.repeat(64)}` } },
    { ...input, schema: { ...input.schema, schemaUri: 'urn:wrong' } },
  ])('rejects invalid application input or schema identity', (invalidInput) => {
    expect(() => loadSamples(file({ ...document, samples: [{ ...document.samples[0], input: invalidInput }] }))).toThrow(/samples.0.input/);
  });
  it('rejects unresolvable gold pointers before execution', () => {
    const sample = document.samples[0];
    expect(() => loadSamples(file({ ...document, samples: [{ ...sample,
      evaluationContext: { checks: [{ ...sample.evaluationContext.checks[0], expectedPointer: '/absent' }] },
    }] }))).toThrow(/expectedPointer.*resolve/);
  });
  it('rejects cyclic YAML aliases without recursing into validators', () => {
    const path = file(document).replace(/json$/, 'yaml');
    writeFileSync(path, 'schemaVersion: omk.eval-sample-set/v3\nsamples:\n  - sampleId: cycle\n    input: {inputKind: text, text: Q}\n    expected: &gold {again: *gold}\n');
    expect(() => loadSamples(path)).toThrow(/acyclic JSON/);
  });
  it('does not reinterpret legacy fields as v3', () => {
    expect(() => loadSamples(file({ ...document, samples: [{ sampleId: 'x', prompt: 'old' }] }))).toThrow();
  });
});
