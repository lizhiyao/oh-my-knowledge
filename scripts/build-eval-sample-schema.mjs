import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { generateEvalSampleSetJsonSchema } from '../dist/eval-workflows/inputs/schemas/json-schema.js';

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
  throw new Error('Usage: node scripts/build-eval-sample-schema.mjs <--write|--check>');
}

const schemaDir = resolve('schemas/eval-samples/v2');
const fileName = 'eval-sample-set.schema.json';

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

const rendered = `${JSON.stringify(sortJson(generateEvalSampleSetJsonSchema()), null, 2)}\n`;

if (mode === '--write') {
  mkdirSync(schemaDir, { recursive: true });
  for (const candidate of readdirSync(schemaDir)) {
    if (candidate.endsWith('.schema.json') && candidate !== fileName) {
      rmSync(resolve(schemaDir, candidate));
    }
  }
  writeFileSync(resolve(schemaDir, fileName), rendered);
  console.log('Generated Eval Sample Set v2 schema.');
  process.exit(0);
}

const filePath = resolve(schemaDir, fileName);
if (!existsSync(filePath) || readFileSync(filePath, 'utf8') !== rendered) {
  console.error(`${fileName} is missing or stale`);
  console.error('Run `yarn build:schemas` and commit the generated file.');
  process.exit(1);
}
const unexpected = readdirSync(schemaDir).filter(
  (candidate) => candidate.endsWith('.schema.json') && candidate !== fileName,
);
if (unexpected.length > 0) {
  console.error(`Unexpected Eval Sample schemas: ${unexpected.join(', ')}`);
  process.exit(1);
}
console.log('Checked Eval Sample Set v2 schema.');
