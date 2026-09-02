import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import _Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { generateEvalSampleSetJsonSchema } from '../../src/inputs/schemas/json-schema.js';
import {
  createEvalSampleSetDocument,
  EvalSampleSetDocumentSchema,
} from '../../src/inputs/schemas/sample-set.js';

const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;

describe('Eval Sample Set v1 JSON Schema', () => {
  it('matches the committed deterministic JSON Schema 2020-12 artifact', () => {
    const generated = generateEvalSampleSetJsonSchema();
    const committed = JSON.parse(readFileSync(resolve(
      'schemas/eval-samples/v1/eval-sample-set.schema.json',
    ), 'utf8'));

    expect(generated).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: expect.stringContaining('/schemas/eval-samples/v1/eval-sample-set.schema.json'),
    });
    expect(committed).toEqual(generated);
    expect(JSON.stringify(generated)).not.toContain(':{}');
  });

  it('compiles and agrees with the runtime schema on strict structural cases', () => {
    const validate = new Ajv2020({ strict: false }).compile(
      generateEvalSampleSetJsonSchema() as object,
    );
    const valid = createEvalSampleSetDocument([{
      sample_id: 's1',
      prompt: 'Review this change.',
      assertions: [{ type: 'contains', value: 'token' }],
      mocks: [{ tool: 'Read', return: 'fixture' }],
    }]);
    const invalidCases = [
      [{ sample_id: 's1', prompt: 'legacy array' }],
      { samples: [{ sample_id: 's1', prompt: 'missing version' }] },
      { ...valid, typo: true },
      { ...valid, samples: [{ ...valid.samples[0], mockStrict: true }] },
      {
        ...valid,
        samples: [{
          sample_id: 's1',
          prompt: 'ambiguous return source',
          mocks: [{ tool: 'Read', return: 'inline', return_file: 'fixture.txt' }],
        }],
      },
      {
        ...valid,
        samples: [{
          sample_id: 's1',
          prompt: 'ambiguous URL matcher',
          mocks: [{
            tool: 'WebFetch',
            match: { url: 'https://example.com', url_glob: 'https://example.com/*' },
            return: 'fixture',
          }],
        }],
      },
    ];

    expect(validate(valid)).toBe(true);
    expect(EvalSampleSetDocumentSchema.safeParse(valid).success).toBe(true);
    for (const invalid of invalidCases) {
      expect(validate(invalid)).toBe(false);
      expect(EvalSampleSetDocumentSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
