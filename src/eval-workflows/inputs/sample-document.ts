import { normalizeAuthoredSample } from './sample-mapping.js';
import { isJsonValue } from '../../shared/json-value.js';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { Sample } from './contracts/sample.js';
import { detailedSchemaIssue, rejectLegacySampleVersion } from './schemas/error.js';
import { EvalSampleSetDocumentSchema } from './schemas/sample-set.js';
import { parseYaml } from './load-samples.js';

function isYamlPath(filePath: string): boolean {
  return /\.(ya?ml)$/i.test(filePath);
}

export function parseSampleDocument(filePath: string, raw = readFileSync(filePath, 'utf-8')): unknown {
  return isYamlPath(filePath) ? parseYaml(raw) : JSON.parse(raw);
}

export function getSamplesArray(document: unknown, filePath: string): Sample[] {
  rejectLegacySampleVersion(document);
  if (!isJsonValue(document)) throw new Error(`invalid samples file shape: ${filePath}: expected acyclic JSON data with depth below 32`);
  const parsed = EvalSampleSetDocumentSchema.safeParse(document);
  if (parsed.success) return parsed.data.samples.map(normalizeAuthoredSample);
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
