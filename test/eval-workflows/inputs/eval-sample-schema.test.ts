import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import _Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { generateEvalSampleSetJsonSchema } from '../../../src/eval-workflows/inputs/schemas/json-schema.js';
import {
  createWorkflowSampleSetDocument,
  EvalSampleSetDocumentSchema,
} from '../../../src/eval-workflows/inputs/schemas/sample-set.js';

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;

describe('Eval Sample Set v3 JSON Schema', () => {
  it('matches the committed deterministic JSON Schema 2020-12 artifact', () => {
    const generated = generateEvalSampleSetJsonSchema();
    const committed = JSON.parse(readFileSync(resolve(
      'schemas/eval-samples/v3/eval-sample-set.schema.json',
    ), 'utf8'));

    expect(generated).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: expect.stringContaining('/schemas/eval-samples/v3/eval-sample-set.schema.json'),
    });
    expect(committed).toEqual(generated);
    expect(JSON.stringify(generated)).not.toContain(':{}');
  });

  it('compiles and agrees with the runtime schema on strict structural cases', () => {
    const validate = new Ajv2020({ strict: false }).compile(
      generateEvalSampleSetJsonSchema() as object,
    );
    const valid = createWorkflowSampleSetDocument([{
      sample_id: 's1',
      input: { inputKind: 'text' as const, text: 'Review this change.' },
      rubric: { quality: { criterion: 'The answer is correct.', weight: 1 } },
      assertions: [{ type: 'contains', value: 'token' }],
      mocks: [{ tool: 'Read', return: 'fixture' }],
    }]);
    const invalidCases = [
      [{ sample_id: 's1', input: { inputKind: 'text' as const, text: 'legacy array' } }],
      { samples: [{ sample_id: 's1', input: { inputKind: 'text' as const, text: 'missing version' } }] },
      { ...valid, typo: true },
      { ...valid, samples: [{ ...valid.samples[0], mockStrict: true }] },
      { ...valid, samples: [{ ...valid.samples[0], evaluationContext: { rubric: {} } }] },
      {
        ...valid,
        samples: [{
          ...valid.samples[0],
          executionContext: { mocks: [{ tool: 'Read', return: 'inline', return_file: 'fixture.txt' }] },
        }],
      },
      {
        ...valid,
        samples: [{
          ...valid.samples[0],
          executionContext: { mocks: [{
            tool: 'WebFetch',
            match: { url: 'https://example.com', url_glob: 'https://example.com/*' },
            return: 'fixture',
          }] },
        }],
      },
    ];

    expect(validate(valid)).toBe(true);
    expect(EvalSampleSetDocumentSchema.safeParse(valid).success).toBe(true);
    for (const invalid of invalidCases) {
      expect(validate(invalid)).toBe(false);
      expect(EvalSampleSetDocumentSchema.safeParse(invalid).success).toBe(false);
    }
    expect(EvalSampleSetDocumentSchema.safeParse({
      ...valid,
      samples: [{
        ...valid.samples[0],
        evaluationContext: { rubric: {
          accuracy: { criterion: 'Correct.', weight: 0.7 },
          clarity: { criterion: 'Clear.', weight: 0.4 },
        } },
      }],
    }).success).toBe(false);
  });
});
