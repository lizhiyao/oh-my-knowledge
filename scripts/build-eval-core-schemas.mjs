import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { generateWireJsonSchemas } from '../dist/eval-core/contracts/json-schema.js';

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
  throw new Error('Usage: node scripts/build-eval-core-schemas.mjs <--write|--check>');
}

const schemaDir = resolve('schemas/eval-core/v1');
const schemas = generateWireJsonSchemas();

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

const rendered = Object.fromEntries(
  Object.entries(schemas).map(([fileName, schema]) => [
    fileName,
    `${JSON.stringify(sortJson(schema), null, 2)}\n`,
  ]),
);

if (mode === '--write') {
  mkdirSync(schemaDir, { recursive: true });
  const expected = new Set(Object.keys(rendered));
  for (const fileName of readdirSync(schemaDir)) {
    if (fileName.endsWith('.schema.json') && !expected.has(fileName)) {
      rmSync(resolve(schemaDir, fileName));
    }
  }
  for (const [fileName, contents] of Object.entries(rendered)) {
    writeFileSync(resolve(schemaDir, fileName), contents);
  }
  console.log(`Generated ${Object.keys(rendered).length} Evaluation Core schemas.`);
  process.exit(0);
}

const errors = [];
const actualFiles = existsSync(schemaDir)
  ? readdirSync(schemaDir).filter((fileName) => fileName.endsWith('.schema.json')).sort()
  : [];
const expectedFiles = Object.keys(rendered).sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  errors.push(`schema file set differs: expected ${expectedFiles.join(', ')}, found ${actualFiles.join(', ')}`);
}
for (const [fileName, contents] of Object.entries(rendered)) {
  const filePath = resolve(schemaDir, fileName);
  if (!existsSync(filePath)) continue;
  if (readFileSync(filePath, 'utf8') !== contents) errors.push(`${fileName} is stale`);
}
if (errors.length > 0) {
  console.error(errors.join('\n'));
  console.error('Run `yarn build:schemas` and commit the generated files.');
  process.exit(1);
}
console.log(`Checked ${expectedFiles.length} Evaluation Core schemas.`);
