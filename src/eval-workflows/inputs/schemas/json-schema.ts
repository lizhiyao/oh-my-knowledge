import { z } from 'zod';
import { EvalSampleSetDocumentSchema } from './sample-set.js';

const SCHEMA_URI =
  'https://raw.githubusercontent.com/lizhiyao/oh-my-knowledge/main/schemas/eval-samples/v2/eval-sample-set.schema.json';

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

function annotateRubricContract(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(annotateRubricContract);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  const properties = node.properties;
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const rubric = (properties as Record<string, unknown>).rubric;
    if (rubric !== null && typeof rubric === 'object' && !Array.isArray(rubric)) {
      Object.assign(rubric, {
        minProperties: 1,
        $comment: 'Runtime validation additionally requires all rubric weights to sum to 1 within 1e-9.',
      });
    }
  }
  Object.values(node).forEach(annotateRubricContract);
}

export function generateEvalSampleSetJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(EvalSampleSetDocumentSchema, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    cycles: 'ref',
    reused: 'ref',
  });
  annotateRubricContract(generated);
  const schema = { ...generated, $id: SCHEMA_URI };
  assertNoEmptySchemaNode(schema);
  return schema;
}
