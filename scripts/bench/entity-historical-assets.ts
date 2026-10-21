import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const hash = (raw: string | Uint8Array) => `sha256:${createHash('sha256').update(raw).digest('hex')}`;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const file = z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: digest, endsWithLf: z.boolean() });
const revision = z.object({ directory: z.string(), manifestDigest: digest, examplesDigest: digest, candidatePromptDigest: digest });
const pair = z.object({ originalRulePrefixBytes: z.number().int().positive(), originalRulePrefixDigest: digest,
  sharedWireInstructionsDigest: digest, sharedWireSchemaDigest: digest, blockDigest: digest.optional(),
  blockBytes: z.number().int().positive(), baselineBytes: z.number().int().positive(), candidateBytes: z.number().int().positive() });
const manifestSchema = z.object({ manifestKind: z.string(), assetVersion: z.number().int().min(1).max(4),
  productionActivated: z.boolean(), modelCalls: z.literal(0), gold: z.literal('none'), qualityConclusion: z.literal('not_evaluated'),
  humanReview: z.literal('pending'), independentHumanReview: z.literal('pending'),
  dataUse: z.literal('prompt-demonstration-only;not-an-evaluation-split'), sourceManifestDigest: digest, wireId: digest,
  authorReview: z.literal('completed').optional(),
  validators: z.object({ zod: z.string(), ajv: z.string() }), pair, revisionOf: revision.optional(),
  arms: z.object({ control: z.object({ file: z.string() }), candidate: z.object({ file: z.string() }) }), files: z.array(file),
});
const sourceSchema = z.object({ wireId: digest, promptEncoding: z.literal('raw-utf8-no-added-final-newline'),
  sourceDirectory: z.string(),
  revisionOf: revision.optional(), files: z.array(file).optional(), provenance: z.record(z.string(), z.unknown()).optional(),
});
const examplesSchema = z.object({ assetVersion: z.number().int(), gold: z.literal('none'), humanReview: z.literal('pending'),
  independentHumanReview: z.literal('pending'), productionActivated: z.boolean(), wireId: digest.optional(),
  provenance: z.record(z.string(), z.unknown()), examples: z.array(z.object({ exampleId: z.string(), input: z.unknown(),
    output: z.object({ entities: z.array(z.object({ entityId: z.string(), qualifiers: z.array(z.string()), referentKind: z.string() }).passthrough()) }).passthrough(),
  }).passthrough()),
});
const authorSchema = z.object({ reviewKind: z.literal('ai-author-review'), status: z.literal('completed'), independentHumanAttestation: z.literal(false),
  revisionOf: revision, examplesDigest: digest, controlPromptDigest: digest, candidatePromptDigest: digest,
  bindings: z.object({ examplesFile: z.string(), examplesDigest: digest, controlPromptFile: z.string(), controlPromptDigest: digest,
    candidatePromptFile: z.string(), candidatePromptDigest: digest }),
});
const wireSchema = z.object({ wireId: digest, wireSchemaDigest: digest, actualValidators: z.object({ zod: z.string(), ajv: z.string() }),
  nullableOptionals: z.array(z.unknown()),
}).passthrough();

// These historical anchors are independent of the current production prompt/runtime.
const bundles = [
  { directory: 'entity-extraction-four-positive-strict-v1', version: 1,
    manifest: '49d70b7b12ef3ce8f7df910f321d67d8de9d32e8863f28a9615e9adbbdd45c66',
    verifier: '4ac47163612deb3f2b74aeacaf86d9b53d1f236f46cb05795e919bfa01dba981' },
  { directory: 'entity-extraction-four-positive-strict-v2', version: 2,
    manifest: '54e48450a3f17954fade896052d12c23880e3a9e2e10d6405b6e2c030612c191',
    verifier: '2aac73f34009af2335c1833192325ce0337aa4678ee5aa732d9033e51f1da62a' },
  { directory: 'entity-extraction-five-positive-strict-v3', version: 3,
    manifest: 'a9bcb1042e691b365459436635dd74e1c40788225ad1eb4cd470f43cc6dcdbea',
    verifier: '08e275d09cf5157d9d8a60436cadb88706a66dd65708f72bc742f6fea3b29dca' },
  { directory: 'entity-extraction-five-positive-strict-v4', version: 4,
    manifest: 'e54f2df9079142fb52ac5efa840b1be67f7c7207e632ec6d7b0e32864231e3d3',
    verifier: '6d3ba21df43b23461da69fab197bc2d4ae694c1f9aa9db76e32ddbbecdee9c4d' },
] as const;
const finalRule = '输出纯 JSON 对象，responseKind 为 knowledge-extraction，schemaVersion 为 4，不要 Markdown 围栏。整个响应严格遵守以下 JSON Schema：\n';
function utf8(raw: Buffer, name: string) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    assert(Buffer.from(text).equals(raw), `${name}: raw UTF-8 round trip`);
    return text;
  } catch (cause) { throw new Error(`${name}: invalid raw UTF-8`, { cause }); }
}
function json<T extends z.ZodType>(raw: Buffer, name: string, schema: T): z.infer<T> {
  const value: unknown = JSON.parse(utf8(raw, name)); schema.parse(value);
  // Preserve original property order for historical JSON.stringify/prompt identities.
  return value as z.infer<T>;
}
function read(directory: string, name: string): Buffer {
  assert(name.length && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..', 'Asset filename must be local.');
  const path = join(directory, name), stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${name}: expected a regular non-symlink file`);
  assert(stat.size <= 2 * 1024 * 1024, `${name}: oversized historical asset`);
  return readFileSync(path);
}
function renderExamples(examples: z.infer<typeof examplesSchema>['examples'], five: boolean) {
  if (!five) return '\n以下四个新合成 development 正例仅演示既有规则与同一 strict-wire 格式；内容不是真实任务事实。输出是完整 wire JSON，null 占位经上述宿主映射返回原 Schema v4 领域值；不包含宿主负例或拒绝结果。\n'
    + examples.map((example, index) => `示例 ${index + 1}\n输入：${JSON.stringify(example.input)}\n输出：${JSON.stringify(example.output)}`).join('\n') + '\n';
  return `以下正例共 ${examples.length} 例，是合成示范，用于展示前述规则如何落实；不是当前窗口的事实，也不是待复制的实体或知识。只依据当前输入提炼。\n`
    + examples.map((example, index) => `正例 ${index + 1}：完整输入与一个合法 wire 输出示范。\n输入：\n${JSON.stringify(example.input)}\n输出：\n${JSON.stringify(example.output)}`).join('\n\n')
    + '\n\n宿主逐项接纳诊断（故障注入说明，不是模型输出示范）：保持正例 4 的原始输入不变，保留正确候选 p_gate；测试另复制一个候选为 p_bad_quote，仅把第一条引用的 quote 改成原文不存在的“BeaconTray 已经完成人工复核并发布。”。这个故意错误的副本由宿主以 citation:quote_mismatch 拒绝，正确的 p_gate 仍被保留，原始响应字节也不得改写。不得生成或模仿这个错误副本；本诊断对应的合法输出示范仍是正例 4 所示、仅含 p_gate 的 JSON。';
}

/** Read only fixed repository assets; sourceDirectory/readScope are declarations, never paths to follow. */
export function verifyHistoricalEntityAssets(repository: string) {
  const assetRoot = join(resolve(repository), 'scripts/bench/assets');
  const verified = bundles.map(bundle => {
    try {
      const directory = join(assetRoot, bundle.directory), stat = lstatSync(directory);
      assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Historical bundle must be a non-symlink directory.');
      const bytes = (name: string) => read(directory, name), manifestBytes = bytes('manifest.json');
      const manifest = json(manifestBytes, 'manifest.json', manifestSchema);
      assert.equal(manifest.manifestKind, `omk-entity-fewshot-candidate-assets/v${bundle.version}`, 'manifest version');
      assert.equal(manifest.assetVersion, bundle.version, 'asset version');
      assert.equal(manifest.productionActivated, bundle.version === 4, 'historical activation declaration');
      const sourceBytes = bytes('source-manifest.json'), source = json(sourceBytes, 'source-manifest.json', sourceSchema);
      assert.equal(hash(sourceBytes), manifest.sourceManifestDigest, 'source manifest digest');
      assert.equal(source.wireId, manifest.wireId, 'source wire binding');
      const expected = ['source-manifest.json', 'strict-positive-examples.json', 'v14-derived-strict.prompt.txt',
        bundle.version < 3 ? 'v15-candidate-strict.prompt.txt' : bundle.version === 3 ? 'v17-candidate-strict.prompt.txt' : 'v18-candidate-strict.prompt.txt',
        'wire-identity.json', 'wire-schema.json', ...(bundle.version > 1 ? ['author-review.json'] : [])];
      assert.deepEqual(manifest.files.map(value => value.path).sort(), expected.sort(), 'complete historical file inventory');
      for (const file of manifest.files) {
        const raw = bytes(file.path); utf8(raw, file.path);
        assert.equal(raw.length, file.bytes, `${file.path}: bytes`);
        assert.equal(hash(raw), file.sha256, `${file.path}: digest`);
        assert.equal(raw.at(-1) === 10, file.endsWithLf, `${file.path}: final LF`);
      }
      const examples = json(bytes('strict-positive-examples.json'), 'strict-positive-examples.json', examplesSchema);
      assert.equal(examples.assetVersion, bundle.version, 'examples version');
      assert.equal(examples.productionActivated, bundle.version === 4, 'example activation declaration');
      assert.equal(examples.examples.length, bundle.version < 3 ? 4 : 5, 'historical example count');
      assert.equal(new Set(examples.examples.map(value => value.exampleId)).size, examples.examples.length, 'unique example identity');
      if (examples.wireId) assert.equal(examples.wireId, manifest.wireId, 'example wire binding');
      if (bundle.version === 3) {
        for (const field of ['corpusCasesRead', 'validationCasesRead', 'realLogsRead', 'modelCalls']) {
          assert.equal(source.provenance?.[field], 0, `source provenance ${field}`);
          assert.equal(examples.provenance[field], 0, `example provenance ${field}`);
        }
      }
      if (bundle.version === 4) {
        assert.deepEqual(examples.provenance, source.provenance, 'revised provenance binding');
        assert.equal(source.provenance?.sourceKind, 'revision-of-viewed-synthetic-examples', 'viewed development provenance');
      }
      const control = bytes(manifest.arms.control.file), candidate = bytes(manifest.arms.candidate.file), schema = bytes('wire-schema.json');
      const suffix = Buffer.concat([Buffer.from(finalRule), schema]);
      assert(control.subarray(-suffix.length).equals(suffix), 'preserved final rule and schema');
      const prefix = control.subarray(0, -suffix.length), block = Buffer.from(renderExamples(examples.examples, bundle.version > 2));
      assert.equal(hash(prefix.subarray(0, manifest.pair.originalRulePrefixBytes)), manifest.pair.originalRulePrefixDigest, 'original rule prefix');
      assert.equal(hash(prefix.subarray(manifest.pair.originalRulePrefixBytes)), manifest.pair.sharedWireInstructionsDigest, 'shared wire instructions');
      assert.equal(hash(schema), manifest.pair.sharedWireSchemaDigest, 'shared wire schema');
      assert.equal(block.length, manifest.pair.blockBytes, 'historical block bytes');
      const sourceBlock = source.files?.find(value => value.path === 'strict-positive-fewshot-block.txt');
      assert.equal(hash(block), manifest.pair.blockDigest ?? sourceBlock?.sha256, 'historical block digest');
      assert(candidate.equals(Buffer.concat([prefix, block, Buffer.from('\n'), suffix])), 'historical control/candidate composition');
      assert.equal(control.length, manifest.pair.baselineBytes, 'control bytes');
      assert.equal(candidate.length, manifest.pair.candidateBytes, 'candidate bytes');
      const wire = json(bytes('wire-identity.json'), 'wire-identity.json', wireSchema);
      const { wireId, actualValidators, nullableOptionals: _nullableOptionals, ...identity } = wire;
      assert.equal(wireId, manifest.wireId, 'wire identity binding');
      assert.equal(hash(JSON.stringify(identity)), wireId, 'wire identity digest');
      assert.deepEqual(actualValidators, manifest.validators, 'declared validators');
      assert.equal(wire.wireSchemaDigest, hash(schema), 'wire schema binding');
      if (bundle.version > 1) {
        const previous = bundles[bundle.version - 2], previousDirectory = join(assetRoot, previous.directory);
        const previousBytes = (name: string) => read(previousDirectory, name), previousManifest = json(previousBytes('manifest.json'), 'previous manifest', manifestSchema);
        assert.equal(manifest.revisionOf?.directory, `scripts/bench/assets/${previous.directory}`, 'revision directory');
        assert.equal(manifest.revisionOf?.manifestDigest, hash(previousBytes('manifest.json')), 'revision manifest digest');
        assert.equal(manifest.revisionOf?.examplesDigest, hash(previousBytes('strict-positive-examples.json')), 'revision examples digest');
        assert.equal(manifest.revisionOf?.candidatePromptDigest, hash(previousBytes(previousManifest.arms.candidate.file)), 'revision candidate digest');
        if (bundle.version === 4) {
          assert.deepEqual(source.revisionOf, manifest.revisionOf, 'source revision binding');
          assert.equal(source.sourceDirectory, manifest.revisionOf?.directory, 'source directory declaration binding');
        }
        for (const name of ['v14-derived-strict.prompt.txt', 'wire-identity.json', 'wire-schema.json']) {
          assert(bytes(name).equals(previousBytes(name)), `${name}: frozen chain bytes`);
        }
        const previousExamples = json(previousBytes('strict-positive-examples.json'), 'previous examples', examplesSchema).examples;
        if (bundle.version === 2) {
          assert.deepEqual(examples.examples.map(value => value.input), previousExamples.map(value => value.input), 'v2 source inputs preserved');
          for (const index of [0, 2]) assert.deepEqual(examples.examples[index], previousExamples[index], 'v2 unchanged examples');
        } else if (bundle.version === 3) assert.deepEqual(examples.examples.slice(0, 4), previousExamples, 'v3 four inherited examples');
        else {
          const expected = structuredClone(previousExamples); expected[4].exampleId = 'synthetic-version-artifact-v2';
          const prompt = expected[4].output.entities.find(value => value.entityId === 'e_prompt');
          assert(prompt, 'v3 prompt entity'); assert.deepEqual(prompt.qualifiers, ['当前版本 knowledge-extraction-v14'], 'v3 qualifier');
          prompt.qualifiers = ['当前版本 v14'];
          assert.deepEqual(examples.examples, expected, 'v4 only declared fifth-example correction');
        }
        const author = json(bytes('author-review.json'), 'author-review.json', authorSchema);
        assert.equal(manifest.authorReview, 'completed', 'manifest author-review declaration');
        assert.deepEqual(author.revisionOf, manifest.revisionOf, 'author revision binding');
        assert.equal(author.examplesDigest, hash(bytes('strict-positive-examples.json')), 'author examples binding');
        assert.equal(author.controlPromptDigest, hash(control), 'author control binding');
        assert.equal(author.candidatePromptDigest, hash(candidate), 'author candidate binding');
        assert.deepEqual(author.bindings, { examplesFile: 'strict-positive-examples.json', examplesDigest: author.examplesDigest,
          controlPromptFile: manifest.arms.control.file, controlPromptDigest: author.controlPromptDigest,
          candidatePromptFile: manifest.arms.candidate.file, candidatePromptDigest: author.candidatePromptDigest }, 'author file bindings');
      }
      // Check pinned outer bytes too: updating a payload and its manifest cannot rebaseline history.
      assert.equal(hash(manifestBytes), `sha256:${bundle.manifest}`, 'frozen manifest anchor');
      assert.equal(hash(bytes('verify.mjs')), `sha256:${bundle.verifier}`, 'frozen verifier anchor');
      return { directory: bundle.directory, manifestDigest: hash(manifestBytes), payloadFiles: manifest.files.length,
        historicalPromptVersion: bundle.version < 3 ? 'knowledge-extraction-v15' : bundle.version === 3 ? 'knowledge-extraction-v17' : 'knowledge-extraction-v18' };
    } catch (cause) { throw new Error(`${bundle.directory}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
  });
  return { verificationVersion: 'omk-entity-historical-assets/v1' as const, status: 'verified' as const,
    scope: 'frozen-package-self-consistency' as const, modelCallsByThisCommand: 0 as const, bundles: verified,
    productionEquality: 'not_assessed' as const, qualityConclusion: 'not_evaluated' as const, humanReview: 'pending' as const,
    limits: ['Historical package bytes and internal bindings only; current production equality, historical admission replay and semantic quality are not assessed.',
      'Historical sourceDirectory/readScope are preserved declarations; no external source path is followed and no original verifier is executed.',
      'No old asset, capture, receipt, model result or readiness identity is rewritten.'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    process.stdout.write('验证冻结 v1–v4 实体示范包；不比较当前生产版本，模型调用为零。\nVerify frozen v1–v4 entity-demonstration packages without current-production comparison or model calls.\nnode dist-scripts/bench/entity-historical-assets.js\n');
  } else if (process.argv.length !== 2) { process.stderr.write('Expected no arguments or --help.\n'); process.exitCode = 2; }
  else {
    try { process.stdout.write(JSON.stringify(verifyHistoricalEntityAssets(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))) + '\n'); }
    catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
  }
}
