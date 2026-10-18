#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assetRoot = dirname(fileURLToPath(import.meta.url));
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--help') { console.log('node verify.mjs'); process.exit(0); }
  throw new Error(`Unexpected argument ${process.argv[i]}`);
}
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const read = (root, name) => {
  assert(!name.includes('/') && !name.includes('\\'));
  const path = resolve(root, name); const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink()); return readFileSync(path);
};
const bytes = name => read(assetRoot, name);
const utf8 = raw => { const value = new TextDecoder('utf-8', { fatal: true }).decode(raw); assert(Buffer.from(value).equals(raw)); return value; };
const json = name => JSON.parse(utf8(bytes(name)));
const manifest = json('manifest.json');
assert.equal(manifest.manifestKind, 'omk-entity-fewshot-candidate-assets/v4'); assert.equal(manifest.assetVersion, 4);
assert.equal(manifest.productionActivated, true); assert.equal(manifest.modelCalls, 0); assert.equal(manifest.gold, 'none');
assert.equal(manifest.humanReview, 'pending'); assert.equal(manifest.independentHumanReview, 'pending');
assert.equal(manifest.dataUse, 'prompt-demonstration-only;not-an-evaluation-split');
assert.equal(hash(bytes('source-manifest.json')), manifest.sourceManifestDigest);
const source = json('source-manifest.json');
assert.equal(source.provenance.sourceKind, 'revision-of-viewed-synthetic-examples');
assert.equal(source.provenance.modelCalls, 0);

const previousRoot = fileURLToPath(new URL('../entity-extraction-five-positive-strict-v3/', import.meta.url));
const previousBytes = name => read(previousRoot, name);
assert.equal(manifest.revisionOf.directory, 'scripts/bench/assets/entity-extraction-five-positive-strict-v3');
assert.equal(hash(previousBytes('manifest.json')), manifest.revisionOf.manifestDigest);
const previousFiles = new Map(JSON.parse(utf8(previousBytes('manifest.json'))).files.map(file => [file.path, file]));
assert.equal(hash(previousBytes('strict-positive-examples.json')), manifest.revisionOf.examplesDigest);
assert.equal(hash(previousBytes('v17-candidate-strict.prompt.txt')), manifest.revisionOf.candidatePromptDigest);

assert.deepEqual(manifest.files.map(file => file.path).sort(), ['author-review.json', 'source-manifest.json', 'strict-positive-examples.json', 'v14-derived-strict.prompt.txt', 'v18-candidate-strict.prompt.txt', 'wire-identity.json', 'wire-schema.json'].sort());
for (const file of manifest.files) {
  const raw = bytes(file.path); utf8(raw); assert.equal(raw.length, file.bytes); assert.equal(hash(raw), file.sha256); assert.equal(raw.at(-1) === 10, file.endsWithLf);
  if (['v14-derived-strict.prompt.txt', 'wire-identity.json', 'wire-schema.json'].includes(file.path)) {
    assert.equal(file.sha256, previousFiles.get(file.path).sha256, `${file.path} must remain byte-equivalent to v3`);
  }
}

const examples = json('strict-positive-examples.json');
assert.equal(examples.assetVersion, 4); assert.equal(examples.gold, 'none');
assert.equal(examples.humanReview, 'pending'); assert.equal(examples.independentHumanReview, 'pending');
assert.deepEqual(examples.provenance, source.provenance);
const expectedExamples = JSON.parse(utf8(previousBytes('strict-positive-examples.json'))).examples;
assert.equal(expectedExamples.length, 5);
assert.equal(expectedExamples[4].exampleId, 'synthetic-version-artifact-v1');
expectedExamples[4].exampleId = 'synthetic-version-artifact-v2';
const promptEntity = expectedExamples[4].output.entities.find(entity => entity.entityId === 'e_prompt');
assert.deepEqual(promptEntity.qualifiers, ['当前版本 knowledge-extraction-v14']);
promptEntity.qualifiers = ['当前版本 v14'];
assert.deepEqual(examples.examples, expectedExamples, 'Only the fifth example identity and unsupported qualifier may change from v3.');

const author = json('author-review.json');
assert.equal(manifest.authorReview, 'completed');
assert.equal(author.reviewKind, 'ai-author-review'); assert.equal(author.status, 'completed');
assert.equal(author.independentHumanAttestation, false);
assert.deepEqual(author.revisionOf, manifest.revisionOf);
assert.equal(author.examplesDigest, hash(bytes('strict-positive-examples.json')));
const control = bytes(manifest.arms.control.file), candidate = bytes(manifest.arms.candidate.file);
assert.equal(author.controlPromptDigest, hash(control)); assert.equal(author.candidatePromptDigest, hash(candidate));
assert.deepEqual(author.bindings, { examplesFile: 'strict-positive-examples.json', examplesDigest: author.examplesDigest,
  controlPromptFile: manifest.arms.control.file, controlPromptDigest: author.controlPromptDigest,
  candidatePromptFile: manifest.arms.candidate.file, candidatePromptDigest: author.candidatePromptDigest });

// Fixed pure production imports only. This verifier does not dispatch or register a collector arm.
const productionPrompt = await import(pathToFileURL(resolve(repository, 'dist/observability/knowledge-extraction/extraction/strict-prompt.js')).href);
const productionFewshot = await import(pathToFileURL(resolve(repository, 'dist/observability/knowledge-extraction/extraction/strict-fewshot.js')).href);
assert.equal(productionPrompt.STRICT_EXTRACTION_PROMPT_VERSION, 'knowledge-extraction-v18');
assert.equal(hash(candidate), hash(Buffer.from(productionPrompt.STRICT_EXTRACTION_PROMPT, 'utf8')));
assert.equal(hash(control), hash(Buffer.from(productionPrompt.STRICT_EXTRACTION_PROMPT.replace(productionFewshot.STRICT_EXTRACTION_FEWSHOT_BLOCK + '\n', ''), 'utf8')));
assert.equal(hash(Buffer.from(productionFewshot.STRICT_EXTRACTION_FEWSHOT_BLOCK, 'utf8')), manifest.pair.blockDigest);
assert.equal(Buffer.byteLength(productionFewshot.STRICT_EXTRACTION_FEWSHOT_BLOCK), manifest.pair.blockBytes);
assert.deepEqual(examples.examples, JSON.parse(JSON.stringify(productionFewshot.STRICT_EXTRACTION_FEWSHOT_EXAMPLES)));
assert.equal(candidate.length, manifest.pair.candidateBytes); assert.equal(control.length, manifest.pair.baselineBytes);
console.log('entity-extraction-five-positive-strict-v4: verified (production v18, source-grounded qualifier, revision-of v3).');
