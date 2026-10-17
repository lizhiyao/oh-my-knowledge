#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assetRoot = dirname(fileURLToPath(import.meta.url));
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  if (name === '--help' && process.argv.length === 3) {
    console.log('node verify.mjs [--out /tmp/new-report.json]'); process.exit(0);
  }
  assert(name === '--out' && !Object.hasOwn(options, name), 'Use one optional --out named argument.');
  assert(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `Missing value for ${name}`); options[name] = process.argv[i + 1];
}
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const bytes = name => { assert(!name.includes('/') && !name.includes('\\')); const path = resolve(assetRoot, name); const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink()); return readFileSync(path); };
const utf8 = raw => { const value = new TextDecoder('utf-8', { fatal: true }).decode(raw); assert(Buffer.from(value).equals(raw)); return value; };
const json = name => JSON.parse(utf8(bytes(name)));
async function verify() {
  const manifestBytes = bytes('manifest.json'), manifest = JSON.parse(utf8(manifestBytes));
  assert.equal(manifest.manifestKind, 'omk-entity-fewshot-candidate-assets/v2'); assert.equal(manifest.assetVersion, 2); assert.equal(manifest.productionActivated, false);
  assert.equal(manifest.dataUse, 'prompt-demonstration-only;not-an-evaluation-split'); assert.equal(manifest.gold, 'none');
  assert.equal(manifest.humanReview, 'pending'); assert.equal(manifest.independentHumanReview, 'pending');
  const sourceBytes = bytes('source-manifest.json'), source = JSON.parse(utf8(sourceBytes));
  assert.equal(hash(sourceBytes), manifest.sourceManifestDigest);
  assert.equal(manifest.sourceManifestDigest, 'sha256:4179285127f38cd561cfe1169ec3e7cf4970b41f3a88249ed1c2660351faeaef');
  const previousRoot = fileURLToPath(new URL('../entity-extraction-four-positive-strict-v1/', import.meta.url));
  const previousBytes = name => { assert(!name.includes('/') && !name.includes('\\')); const path = resolve(previousRoot, name); const stat = lstatSync(path); assert(stat.isFile() && !stat.isSymbolicLink()); return readFileSync(path); };
  assert.equal(manifest.revisionOf.directory, 'scripts/bench/assets/entity-extraction-four-positive-strict-v1');
  assert.equal(manifest.revisionOf.manifestDigest, 'sha256:49d70b7b12ef3ce8f7df910f321d67d8de9d32e8863f28a9615e9adbbdd45c66');
  assert.equal(hash(previousBytes('manifest.json')), manifest.revisionOf.manifestDigest);
  const previousFiles = new Map(JSON.parse(utf8(previousBytes('manifest.json'))).files.map(file => [file.path, file]));
  assert.equal(manifest.revisionOf.examplesDigest, previousFiles.get('strict-positive-examples.json').sha256);
  assert.equal(manifest.revisionOf.candidatePromptDigest, previousFiles.get('v15-candidate-strict.prompt.txt').sha256);
  assert.equal(hash(previousBytes('strict-positive-examples.json')), manifest.revisionOf.examplesDigest);
  assert.equal(hash(previousBytes('v15-candidate-strict.prompt.txt')), manifest.revisionOf.candidatePromptDigest);
  const sourceFiles = new Map(source.files.map(file => [file.path, file]));
  assert.deepEqual(manifest.files.map(file => file.path).sort(), ['author-review.json', 'source-manifest.json', 'strict-positive-examples.json', 'v14-derived-strict.prompt.txt', 'v15-candidate-strict.prompt.txt', 'wire-identity.json', 'wire-schema.json'].sort());
  for (const file of manifest.files) {
    const raw = bytes(file.path); utf8(raw); assert.equal(raw.length, file.bytes); assert.equal(hash(raw), file.sha256); assert.equal(raw.at(-1) === 10, file.endsWithLf);
    if (['v14-derived-strict.prompt.txt', 'wire-schema.json'].includes(file.path)) { const original = sourceFiles.get(file.path); assert(original); assert.equal(file.sha256, original.sha256); assert.equal(file.bytes, original.bytes); }
  }
  const examples = json('strict-positive-examples.json'); assert.equal(examples.productionActivated, false); assert.equal(examples.examples.length, 4);
  assert.equal(examples.gold, 'none'); assert.equal(examples.humanReview, 'pending'); assert.equal(examples.independentHumanReview, 'pending');
  assert.equal(examples.assetVersion, 2);
  const previousExamples = JSON.parse(utf8(previousBytes('strict-positive-examples.json'))).examples;
  assert.deepEqual(examples.examples.map(example => example.input), previousExamples.map(example => example.input), 'The demonstration inputs remain frozen.');
  for (const index of [0, 2]) assert.deepEqual(examples.examples[index], previousExamples[index], 'Unaffected examples remain byte-equivalent after JSON parsing.');
  assert.equal(examples.provenance.sourceKind, 'new-synthetic-development-examples');
  for (const field of ['corpusCasesRead', 'validationCasesRead', 'realLogsRead', 'modelCalls']) assert.equal(examples.provenance[field], 0);
  const control = bytes(manifest.arms.control.file), candidate = bytes(manifest.arms.candidate.file), schema = bytes('wire-schema.json');
  const finalRule = Buffer.from('输出纯 JSON 对象，responseKind 为 knowledge-extraction，schemaVersion 为 4，不要 Markdown 围栏。整个响应严格遵守以下 JSON Schema：\n');
  assert.equal(hash(finalRule), sourceFiles.get('preserved-final-output-rule.txt').sha256);
  const commonSuffix = Buffer.concat([finalRule, schema]); assert(control.subarray(-commonSuffix.length).equals(commonSuffix));
  const prefix = control.subarray(0, -commonSuffix.length), originalPrefixBytes = manifest.pair.originalRulePrefixBytes;
  assert.equal(hash(prefix.subarray(0, originalPrefixBytes)), manifest.pair.originalRulePrefixDigest);
  const wireInstructions = prefix.subarray(originalPrefixBytes); assert.equal(hash(wireInstructions), manifest.pair.sharedWireInstructionsDigest);
  const header = '\n以下四个新合成 development 正例仅演示既有规则与同一 strict-wire 格式；内容不是真实任务事实。输出是完整 wire JSON，null 占位经上述宿主映射返回原 Schema v4 领域值；不包含宿主负例或拒绝结果。\n';
  const block = Buffer.from(header + examples.examples.map((example, index) => `示例 ${index + 1}\n输入：${JSON.stringify(example.input)}\n输出：${JSON.stringify(example.output)}`).join('\n') + '\n');
  assert.equal(hash(block), manifest.pair.blockDigest); assert.equal(block.length, manifest.pair.blockBytes);
  assert(candidate.equals(Buffer.concat([prefix, block, Buffer.from('\n'), commonSuffix])), 'The only arm difference must be the four complete examples and one LF.');
  assert.equal(candidate.length - control.length, block.length + 1); assert.equal(control.length, manifest.pair.baselineBytes); assert.equal(candidate.length, manifest.pair.candidateBytes);
  const author = json('author-review.json');
  assert.equal(manifest.authorReview, 'completed');
  assert.equal(author.reviewKind, 'ai-author-review'); assert.equal(author.status, 'completed');
  assert.equal(author.independentHumanAttestation, false);
  assert.deepEqual(author.revisionOf, manifest.revisionOf);
  assert.equal(author.examplesDigest, hash(bytes('strict-positive-examples.json')));
  assert.equal(author.controlPromptDigest, hash(control)); assert.equal(author.candidatePromptDigest, hash(candidate));
  assert.deepEqual(author.bindings, { examplesFile: 'strict-positive-examples.json', examplesDigest: author.examplesDigest,
    controlPromptFile: manifest.arms.control.file, controlPromptDigest: author.controlPromptDigest,
    candidatePromptFile: manifest.arms.candidate.file, candidatePromptDigest: author.candidatePromptDigest });
  assert.deepEqual(author.decisions.map(row => row.exampleId).sort(), examples.examples.map(example => example.exampleId).sort());
  assert(author.decisions.every(row => row.decision === 'approved'));
  assert.equal(author.humanReview, 'pending'); assert.equal(author.independentHumanReview, 'pending'); assert.equal(author.gold, 'none');
  const frozen = json('wire-identity.json'); assert.equal(frozen.wireId, manifest.wireId); assert.equal(examples.wireId, manifest.wireId);
  const { wireId, actualValidators, nullableOptionals, ...wireIdentity } = frozen;
  assert.deepEqual(actualValidators, manifest.validators); assert.equal(hash(schema), wireIdentity.wireSchemaDigest);
  const runtime = realpathSync(resolve(repository, 'dist'));
  const paths = ['observability/knowledge-extraction/extraction/model-wire.js', 'observability/knowledge-extraction/extraction/window-proposals.js',
    'observability/knowledge-extraction/extraction/entities.js', 'observability/knowledge-extraction/extraction/quote-occurrence.js', 'observability/knowledge-extraction/extraction/proposals.js',
    'knowledge/contracts.js', 'knowledge/validation.js', 'observability/knowledge-extraction/extraction/prompt.js'];
  const moduleDigests = paths.map(path => ({ path, sha256: hash(readFileSync(resolve(runtime, path))) }));
  const previousFetch = globalThis.fetch; let attemptedFetches = 0;
  globalThis.fetch = async () => { attemptedFetches++; throw new Error('This offline verifier forbids network/model access.'); };
  try {
    // Fixed deterministic production modules only: no executor, bench corpus or capture entry is imported.
    const wirePath = resolve(runtime, paths[0]);
    const wire = await import('../../../../dist/observability/knowledge-extraction/extraction/model-wire.js');
    const checker = await import('../../../../dist/observability/knowledge-extraction/extraction/window-proposals.js');
    const knowledge = await import('../../../../dist/knowledge/contracts.js');
    const production = await import('../../../../dist/observability/knowledge-extraction/extraction/prompt.js');
    const validatorRequire = createRequire(pathToFileURL(wirePath));
    const validators = { zod: validatorRequire('zod/package.json').version, ajv: validatorRequire('ajv/package.json').version };
    assert.deepEqual(validators, manifest.validators, 'Validator version drift needs a new explicit candidate identity; do not silently rebaseline.');
    assert.equal(wire.WINDOW_EXTRACTION_WIRE_ID, wireId, 'Equal schema bytes do not establish equal wire identity.');
    assert.deepEqual(wire.WINDOW_EXTRACTION_WIRE_IDENTITY, wireIdentity); assert.deepEqual(wire.WINDOW_EXTRACTION_WIRE_HOST_ONLY.nullableOptionals, nullableOptionals);
    assert(Buffer.from(wire.WINDOW_EXTRACTION_WIRE_SCHEMA_JSON).equals(schema));
    assert.equal(production.EXTRACTION_PROMPT_VERSION, 'knowledge-extraction-v14');
    const original = Buffer.from(production.EXTRACTION_PROMPT); assert.equal(hash(original), sourceFiles.get('originals/v14.prompt.txt').sha256);
    assert.equal(original.indexOf(finalRule), originalPrefixBytes); assert(prefix.subarray(0, originalPrefixBytes).equals(original.subarray(0, originalPrefixBytes)));
    const checks = [];
    for (const example of examples.examples) {
      const expected = manifest.expectedAuthorChecks.find(row => row.exampleId === example.exampleId); assert(expected);
      const raw = Buffer.from(JSON.stringify(example.output)); assert.equal(hash(raw), expected.wireOutputDigest);
      assert.equal(hash(Buffer.from(JSON.stringify(example.input))), expected.inputDigest);
      const decoded = wire.decodeWindowExtractionWire(raw); assert.equal(decoded.decodeStatus, 'decoded'); assert.equal(decoded.wireStatus, 'valid'); assert.deepEqual(decoded.wireFailures, []);
      assert.equal(hash(Buffer.from(JSON.stringify(decoded.domainInput))), expected.domainOutputDigest, 'Domain mapping must preserve this explicitly revised authored output.');
      assert(checker.WindowExtractionModelSchema.safeParse(decoded.domainInput).success);
      const admitted = checker.checkWindowExtractionResponse(decoded.domainInput, example.input.excerpts);
      assert.deepEqual(admitted.analysis.rejected, []); assert.deepEqual(admitted.rejected, []);
      for (const proposal of admitted.accepted) assert(knowledge.KnowledgeDraftSchema.safeParse(proposal.draft).success);
      const host = { entities: admitted.analysis.entities.length, mentions: admitted.analysis.mentions.length, entityRejections: 0,
        acceptedProposals: admitted.accepted.length, rejectedProposals: 0, knowledgeDraftsValid: admitted.accepted.length };
      assert.deepEqual(host, expected.host); checks.push({ exampleId: example.exampleId, host });
    }
    assert.equal(attemptedFetches, 0);
    const identity = { assetManifestDigest: hash(manifestBytes), verifierDigest: hash(readFileSync(fileURLToPath(import.meta.url))), wireId, wireIdentity, validators,
      nodeVersion: process.versions.node, nodeBinaryDigest: hash(readFileSync(process.execPath)), moduleDigests };
    return { verificationKind: 'omk-entity-fewshot-offline-verification/v1', verificationId: hash(canonical(identity)), identity,
      onlyArmDifference: 'four-positive-strict-fewshot-block-plus-one-lf', blockPlusSeparatorBytes: block.length + 1, checks,
      modelCalls: 0, attemptedFetches, corpusCasesRead: 0, heldoutCasesRead: 0, realSourcesRead: 0,
      authorReview: { reviewKind: author.reviewKind, status: author.status },
      humanReview: 'pending', independentHumanReview: 'pending', gold: 'none', qualityConclusion: 'not_evaluated', productionActivated: false,
      identityScope: 'Listed deterministic components and actual validators only; not a complete model measurement or transitive dependency-byte closure.' };
  } finally { globalThis.fetch = previousFetch; }
}
try {
  const result = await verify();
  if (options['--out']) {
    const target = resolve(options['--out']), parent = realpathSync(dirname(target));
    assert([realpathSync('/tmp'), realpathSync(tmpdir())].some(root => { const rel = relative(root, parent); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); }), 'Reports must be explicitly outside the checkout under an OS temporary directory.');
    const inRepository = relative(realpathSync(repository), parent);
    assert(isAbsolute(inRepository) || inRepository === '..' || inRepository.startsWith(`..${sep}`), 'Never write verification output inside the checkout.');
    assert(!existsSync(target), 'Never overwrite earlier evidence.'); writeFileSync(target, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
