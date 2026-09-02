import { z } from 'zod';
import { EvalSampleSetDocumentSchema } from './sample-set.js';

const SCHEMA_URI =
  'https://raw.githubusercontent.com/lizhiyao/oh-my-knowledge/main/schemas/eval-samples/v1/eval-sample-set.schema.json';

function assertNoEmptySchemaNode(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoEmptySchemaNode(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error(`Eval sample JSON Schema contains an unconstrained node at ${path}`);
  }
  entries.forEach(([key, entry]) => assertNoEmptySchemaNode(entry, `${path}/${key}`));
}

export function generateEvalSampleSetJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(EvalSampleSetDocumentSchema, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    cycles: 'ref',
    reused: 'ref',
  });
  const schema = { ...generated, $id: SCHEMA_URI };
  assertNoEmptySchemaNode(schema);
  return schema;
}
