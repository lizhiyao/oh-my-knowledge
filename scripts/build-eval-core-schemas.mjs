import { createHash } from 'node:crypto';
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
import {
  WIRE_SCHEMA_CATALOG,
  wireSchemaCatalogVersion,
} from '../dist/eval-core/contracts/json-schema.js';

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
  throw new Error('Usage: node scripts/build-eval-core-schemas.mjs <--write|--check>');
}

const schemaRoot = resolve('schemas/eval-core');
const schemas = generateWireJsonSchemas();
const historicalSchemaDigests = new Map([
  ['v1/analysis-bundle.schema.json', '92e49a22dd3d3c4c91b710afe20018a76c5709773c4f06d8c39fbc3c89e3eb97'],
  ['v1/comparability-assessment.schema.json', '1e9e264e11bb136d1b17373981878788ffa30a0a1eebf32b070af43a1c2dbd79'],
  ['v1/evaluation-report.schema.json', '57089f7538da7347870426ed9b499adc289660500b8931f278eb2640d39fee8a'],
  ['v1/series-analysis-bundle.schema.json', '6838725aefbe299c51c84b541114f2785e2739bea31cf8beccc0efc238a72a12'],
  ['v2/execution-plan.schema.json', 'e07ad839db119beb590b2d598f410ec9eb1efef9cf8824a93d0818a03ff4be85'],
  ['v3/evaluation-definition.schema.json', '88b1014e72aabc2c91eda810c5c59a50d088a801dc6464784c02c0f7e6b46541'],
  ['v3/run-plan.schema.json', '52ce28e0a05d6183bb71b3f81d1e1a6af1e7e1fcb39714d9de10e9a3f5acd0a6'],
]);

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

const rendered = Object.fromEntries(WIRE_SCHEMA_CATALOG.map((entry) => {
  const relativePath = `${wireSchemaCatalogVersion(entry)}/${entry.fileName}`;
  return [relativePath, `${JSON.stringify(sortJson(schemas[entry.fileName]), null, 2)}\n`];
}));

function existingSchemaPaths() {
  if (!existsSync(schemaRoot)) return [];
  return readdirSync(schemaRoot, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !/^v[1-9]\d*$/.test(entry.name)) return [];
    return readdirSync(resolve(schemaRoot, entry.name))
      .filter((fileName) => fileName.endsWith('.schema.json'))
      .map((fileName) => `${entry.name}/${fileName}`);
  }).sort();
}

function historicalSchemaErrors() {
  return [...historicalSchemaDigests].flatMap(([relativePath, expectedDigest]) => {
    const filePath = resolve(schemaRoot, relativePath);
    if (!existsSync(filePath)) return [`historical schema is missing: ${relativePath}`];
    const actualDigest = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    return actualDigest === expectedDigest
      ? []
      : [`historical schema changed: ${relativePath}`];
  });
}

if (mode === '--write') {
  const historicalErrors = historicalSchemaErrors();
  if (historicalErrors.length > 0) {
    throw new Error(historicalErrors.join('\n'));
  }
  mkdirSync(schemaRoot, { recursive: true });
  const expected = new Set([...Object.keys(rendered), ...historicalSchemaDigests.keys()]);
  for (const relativePath of existingSchemaPaths()) {
    if (!expected.has(relativePath)) {
      rmSync(resolve(schemaRoot, relativePath));
    }
  }
  for (const [relativePath, contents] of Object.entries(rendered)) {
    const filePath = resolve(schemaRoot, relativePath);
    mkdirSync(resolve(filePath, '..'), { recursive: true });
    writeFileSync(filePath, contents);
  }
  console.log(`Generated ${Object.keys(rendered).length} Evaluation Core schemas.`);
  process.exit(0);
}

const errors = historicalSchemaErrors();
const actualFiles = existingSchemaPaths();
const expectedFiles = [...Object.keys(rendered), ...historicalSchemaDigests.keys()].sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  errors.push(`schema file set differs: expected ${expectedFiles.join(', ')}, found ${actualFiles.join(', ')}`);
}
for (const [relativePath, contents] of Object.entries(rendered)) {
  const filePath = resolve(schemaRoot, relativePath);
  if (!existsSync(filePath)) continue;
  if (readFileSync(filePath, 'utf8') !== contents) errors.push(`${relativePath} is stale`);
}
if (errors.length > 0) {
  console.error(errors.join('\n'));
  console.error('Run `yarn build:schemas` and commit the generated files.');
  process.exit(1);
}
console.log(`Checked ${expectedFiles.length} Evaluation Core schemas.`);
