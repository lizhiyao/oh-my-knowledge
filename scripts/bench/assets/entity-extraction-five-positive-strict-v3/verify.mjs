#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assetRoot = dirname(fileURLToPath(import.meta.url));
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--help') { console.log('node verify.mjs'); process.exit(0); }
  throw new Error(`Unexpected argument ${process.argv[i]}`);
}
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const bytes = name => { assert(!name.includes('/') && !name.includes('\\')); const path = resolve(assetRoot, name); const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink()); return readFileSync(path); };
const utf8 = raw => { const value = new TextDecoder('utf-8', { fatal: true }).decode(raw); assert(Buffer.from(value).equals(raw)); return value; };
const json = name => JSON.parse(utf8(bytes(name)));

const manifestBytes = bytes('manifest.json'); const manifest = JSON.parse(utf8(manifestBytes));
assert.equal(manifest.manifestKind, 'omk-entity-fewshot-candidate-assets/v3'); assert.equal(manifest.assetVersion, 3);
assert.equal(manifest.productionActivated, false); assert.equal(manifest.modelCalls, 0); assert.equal(manifest.gold, 'none');
assert.equal(manifest.humanReview, 'pending'); assert.equal(manifest.independentHumanReview, 'pending');
assert.equal(manifest.dataUse, 'prompt-demonstration-only;not-an-evaluation-split');
const sourceBytes = bytes('source-manifest.json');
assert.equal(hash(sourceBytes), manifest.sourceManifestDigest);
const source = JSON.parse(utf8(sourceBytes));
for (const field of ['corpusCasesRead', 'validationCasesRead', 'realLogsRead', 'modelCalls']) assert.equal(source.provenance[field], 0);

const previousRoot = fileURLToPath(new URL('../entity-extraction-four-positive-strict-v2/', import.meta.url));
const previousBytes = name => { const path = resolve(previousRoot, name); const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink()); return readFileSync(path); };
assert.equal(manifest.revisionOf.directory, 'scripts/bench/assets/entity-extraction-four-positive-strict-v2');
assert.equal(hash(previousBytes('manifest.json')), manifest.revisionOf.manifestDigest);
const previousFiles = new Map(JSON.parse(utf8(previousBytes('manifest.json'))).files.map(file => [file.path, file]));
assert.equal(manifest.revisionOf.examplesDigest, previousFiles.get('strict-positive-examples.json').sha256);
assert.equal(manifest.revisionOf.candidatePromptDigest, previousFiles.get('v15-candidate-strict.prompt.txt').sha256);

assert.deepEqual(manifest.files.map(file => file.path).sort(), ['author-review.json', 'source-manifest.json', 'strict-positive-examples.json', 'v14-derived-strict.prompt.txt', 'v17-candidate-strict.prompt.txt', 'wire-identity.json', 'wire-schema.json'].sort());
for (const file of manifest.files) {
  const raw = bytes(file.path); utf8(raw); assert.equal(raw.length, file.bytes); assert.equal(hash(raw), file.sha256); assert.equal(raw.at(-1) === 10, file.endsWithLf);
  if (['v14-derived-strict.prompt.txt', 'wire-identity.json', 'wire-schema.json'].includes(file.path)) {
    assert.equal(file.sha256, previousFiles.get(file.path).sha256, `${file.path} must remain byte-equivalent to v2`);
  }
}

const examples = json('strict-positive-examples.json');
assert.equal(examples.assetVersion, 3); assert.equal(examples.gold, 'none');
assert.equal(examples.humanReview, 'pending'); assert.equal(examples.independentHumanReview, 'pending');
assert.equal(examples.examples.length, 5);
assert.equal(examples.provenance.sourceKind, 'new-synthetic-development-examples');
for (const field of ['corpusCasesRead', 'validationCasesRead', 'realLogsRead', 'modelCalls']) assert.equal(examples.provenance[field], 0);
const previousExamples = JSON.parse(utf8(previousBytes('strict-positive-examples.json'))).examples;
assert.deepEqual(examples.examples.slice(0, 4), previousExamples, 'The four v2 examples must be carried byte-equivalent.');
assert.equal(examples.examples[4].exampleId, 'synthetic-version-artifact-v1');
assert.equal(examples.examples[4].output.entities.find(entity => entity.referentKind === 'version') !== undefined, true,
  'The new example must demonstrate the archived-artifact → version typing.');

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

// Production consistency: the bundle must match the built production prompt and examples byte for byte.
const productionPrompt = await import(pathToFileURL(resolve(repository, 'dist/knowledge/extraction/strict-prompt.js')).href);
const productionFewshot = await import(pathToFileURL(resolve(repository, 'dist/knowledge/extraction/strict-fewshot.js')).href);
assert.equal(productionPrompt.STRICT_EXTRACTION_PROMPT_VERSION, 'knowledge-extraction-v17');
assert.equal(hash(candidate), hash(Buffer.from(productionPrompt.STRICT_EXTRACTION_PROMPT, 'utf8')));
assert.equal(hash(control), hash(Buffer.from(productionPrompt.STRICT_EXTRACTION_PROMPT.replace(productionFewshot.STRICT_EXTRACTION_FEWSHOT_BLOCK + '\n', ''), 'utf8')));
assert.equal(hash(Buffer.from(productionFewshot.STRICT_EXTRACTION_FEWSHOT_BLOCK, 'utf8')), manifest.pair.blockDigest);
assert.equal(Buffer.byteLength(productionFewshot.STRICT_EXTRACTION_FEWSHOT_BLOCK), manifest.pair.blockBytes);
assert.deepEqual(examples.examples, JSON.parse(JSON.stringify(productionFewshot.STRICT_EXTRACTION_FEWSHOT_EXAMPLES)));
assert.equal(candidate.length, manifest.pair.candidateBytes); assert.equal(control.length, manifest.pair.baselineBytes);
assert.equal(manifest.pair.originalRulePrefixDigest, 'sha256:960b45dc357cd86471a7e55ddd975d71b52de416ff80f001d1a89c921825d909');
console.log('entity-extraction-five-positive-strict-v3: verified (production v17, five examples, revision-of v2).');
