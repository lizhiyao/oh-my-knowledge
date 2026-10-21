import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyHistoricalEntityAssets } from '../../scripts/bench/entity-historical-assets.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directories = ['entity-extraction-four-positive-strict-v1', 'entity-extraction-four-positive-strict-v2',
  'entity-extraction-five-positive-strict-v3', 'entity-extraction-five-positive-strict-v4'];
const temporary: string[] = [];
const hash = (raw: Buffer) => `sha256:${createHash('sha256').update(raw).digest('hex')}`;
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-historical-assets-')); temporary.push(root);
  const assets = join(root, 'scripts/bench/assets');
  mkdirSync(assets, { recursive: true });
  for (const directory of directories) cpSync(join(repository, 'scripts/bench/assets', directory), join(assets, directory), { recursive: true });
  return { root, directory: join(assets, directories[3]) };
}
function updatePayload(directory: string, name: string, mutate: (value: Record<string, unknown>) => void) {
  const path = join(directory, name), value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  mutate(value); writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    sourceManifestDigest?: string;
    files: { path: string; bytes: number; sha256: string; endsWithLf: boolean }[];
  };
  const entry = manifest.files.find(file => file.path === name)!;
  const bytes = readFileSync(path);
  Object.assign(entry, { bytes: bytes.length, sha256: hash(bytes), endsWithLf: bytes.at(-1) === 10 });
  if (name === 'source-manifest.json') manifest.sourceManifestDigest = hash(bytes);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

describe('frozen entity demonstration package verification', () => {
  it('verifies all historical payloads and the revision chain without loading the current production build', () => {
    // This fixture contains only the four frozen packages; no dist, dependencies or external historical sources.
    const f = fixture(), report = verifyHistoricalEntityAssets(f.root);
    expect(report).toMatchObject({ verificationVersion: 'omk-entity-historical-assets/v1', status: 'verified',
      scope: 'frozen-package-self-consistency', modelCallsByThisCommand: 0,
      productionEquality: 'not_assessed', qualityConclusion: 'not_evaluated', humanReview: 'pending' });
    expect(report.bundles.map(bundle => [bundle.directory, bundle.payloadFiles])).toEqual(directories.map((directory, index) => [directory, index ? 7 : 6]));
    expect(report.bundles.slice(2).map(bundle => bundle.manifestDigest)).toEqual([
      'sha256:a9bcb1042e691b365459436635dd74e1c40788225ad1eb4cd470f43cc6dcdbea',
      'sha256:e54f2df9079142fb52ac5efa840b1be67f7c7207e632ec6d7b0e32864231e3d3',
    ]);
    for (const directory of directories) {
      for (const name of ['manifest.json', 'verify.mjs']) expect(readFileSync(join(f.root, 'scripts/bench/assets', directory, name)))
        .toEqual(readFileSync(join(repository, 'scripts/bench/assets', directory, name)));
    }
  });

  it('rejects missing payloads, changed lengths and invalid raw UTF-8 with a bundle/file diagnostic', () => {
    const missing = fixture(); rmSync(join(missing.directory, 'strict-positive-examples.json'));
    expect(() => verifyHistoricalEntityAssets(missing.root)).toThrow(/entity-extraction-five-positive-strict-v4:.*strict-positive-examples.json/);
    const length = fixture(); writeFileSync(join(length.directory, 'v18-candidate-strict.prompt.txt'), 'changed');
    expect(() => verifyHistoricalEntityAssets(length.root)).toThrow('v18-candidate-strict.prompt.txt: bytes');
    const digest = fixture(), prompt = join(digest.directory, 'v18-candidate-strict.prompt.txt'), changed = readFileSync(prompt);
    changed[changed.length - 1] = 32; writeFileSync(prompt, changed);
    expect(() => verifyHistoricalEntityAssets(digest.root)).toThrow('v18-candidate-strict.prompt.txt: digest');
    const encoding = fixture(); writeFileSync(join(encoding.directory, 'wire-schema.json'), Buffer.from([0xff]));
    expect(() => verifyHistoricalEntityAssets(encoding.root)).toThrow('wire-schema.json: invalid raw UTF-8');
    const newline = fixture(), manifestPath = join(newline.directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { path: string; endsWithLf: boolean }[] };
    manifest.files.find(file => file.path === 'wire-schema.json')!.endsWithLf = true;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    expect(() => verifyHistoricalEntityAssets(newline.root)).toThrow('wire-schema.json: final LF');
  });

  it('rejects changed source and author bindings even when the payload digest is updated in its manifest', () => {
    const source = fixture(); updatePayload(source.directory, 'source-manifest.json', value => { value.wireId = `sha256:${'0'.repeat(64)}`; });
    expect(() => verifyHistoricalEntityAssets(source.root)).toThrow('source wire binding');
    const author = fixture(); updatePayload(author.directory, 'author-review.json', value => { value.examplesDigest = `sha256:${'0'.repeat(64)}`; });
    expect(() => verifyHistoricalEntityAssets(author.root)).toThrow('author examples binding');
    const revision = fixture(), path = join(revision.directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { revisionOf: { candidatePromptDigest: string } };
    manifest.revisionOf.candidatePromptDigest = `sha256:${'0'.repeat(64)}`; writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
    expect(() => verifyHistoricalEntityAssets(revision.root)).toThrow('revision candidate digest');
  });

  it('pins outer manifests and original verifier bytes rather than accepting a coordinated rebaseline', () => {
    const manifest = fixture(), path = join(manifest.directory, 'manifest.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    value.extraHistoricalClaim = 'Unapproved new declaration'; writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
    expect(() => verifyHistoricalEntityAssets(manifest.root)).toThrow('frozen manifest anchor');
    const verifier = fixture(); writeFileSync(join(verifier.directory, 'verify.mjs'), '// Do not execute or rewrite historical verifiers.\n');
    expect(() => verifyHistoricalEntityAssets(verifier.root)).toThrow('frozen verifier anchor');
  });

  it('rejects payload symlinks instead of following another evidence location', () => {
    const f = fixture(), original = join(f.directory, 'v14-derived-strict.prompt.txt');
    rmSync(original); symlinkSync(join(repository, 'scripts/bench/assets', directories[3], 'v14-derived-strict.prompt.txt'), original);
    expect(() => verifyHistoricalEntityAssets(f.root)).toThrow('expected a regular non-symlink file');
  });
});
