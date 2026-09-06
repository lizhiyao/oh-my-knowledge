import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { Sample } from './contracts/sample.js';
import { detailedSchemaIssue } from './schemas/error.js';
import { EvalSampleSetDocumentSchema } from './schemas/sample-set.js';
import { parseYaml } from './load-samples.js';

function isYamlPath(filePath: string): boolean {
  return /\.(ya?ml)$/i.test(filePath);
}

export function parseSampleDocument(filePath: string): unknown {
  const raw = readFileSync(filePath, 'utf-8');
  return isYamlPath(filePath) ? parseYaml(raw) : JSON.parse(raw);
}

export function getSamplesArray(document: unknown, filePath: string): Sample[] {
  const parsed = EvalSampleSetDocumentSchema.safeParse(document);
  if (parsed.success) return parsed.data.samples;
  const issue = detailedSchemaIssue(parsed.error);
  const field = issue?.path.length ? issue.path.join('.') : '$';
  throw new Error(`invalid samples file shape: ${filePath}: ${field}: ${issue?.message ?? 'invalid shape'}`);
}

export function stringifySampleDocument(filePath: string, document: unknown): string {
  if (isYamlPath(filePath)) {
    return yaml.dump(document, { lineWidth: -1, noRefs: true });
  }
  return JSON.stringify(document, null, 2);
}
