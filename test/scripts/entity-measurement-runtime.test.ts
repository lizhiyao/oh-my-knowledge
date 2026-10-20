import { execFileSync } from 'node:child_process';
import fs, { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { measurementRuntimeDigest, reviewSourceRevision } from '../../scripts/bench/entity-measurement-runtime.js';

const roots: string[] = [];
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'omk-entity-measurement-runtime-'));
  roots.push(root); return root;
}
afterEach(() => {
  try { for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true }); }
  finally { vi.unstubAllEnvs(); }
});

const assets: [string, string | Uint8Array][] = [
  ['cli/main.js', 'export const runtime = true;\n'],
  ['contracts/schema.json', '{"type":"object"}\n'],
  ['knowledge/template.md', '# Runtime template\n'],
  ['assets/opaque.bin', Buffer.from([0, 255, 128, 1])],
  ['NOTICE', 'Runtime notice\n'],
];
function writeAsset(root: string, path: string, content: string | Uint8Array) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, content);
}
function runtimeFixture(entries = assets) {
  const root = temporaryRoot();
  for (const [path, content] of entries) writeAsset(root, path, content);
  return root;
}

function gitFixture(initialize = true) {
  const sandbox = temporaryRoot(), repository = join(sandbox, 'repository'), empty = join(sandbox, 'empty');
  mkdirSync(repository); mkdirSync(empty);
  // Neither setup nor the function under test may inherit a caller's Git repository or configuration.
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
  const config = join(sandbox, 'gitconfig'); writeFileSync(config, '');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1'); vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_TEMPLATE_DIR', empty); vi.stubEnv('GIT_CEILING_DIRECTORIES', sandbox);
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', repository, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  }).trim();
  if (initialize) {
    git('init', '--quiet', '--initial-branch=main', `--template=${empty}`);
    for (const [key, value] of [
      ['user.name', 'Measurement fixture'], ['user.email', 'measurement-fixture@example.invalid'],
      ['core.hooksPath', empty], ['commit.gpgSign', 'false'], ['core.autocrlf', 'false'], ['core.fsmonitor', 'false'],
    ]) git('config', '--local', key, value);
  }
  writeAsset(repository, '.gitignore', 'node_modules/\n');
  writeAsset(repository, 'runtime.js', 'export const runtime = true;\n');
  const commit = () => {
    git('add', '--', '.gitignore', 'runtime.js'); git('commit', '--quiet', '--message', 'fixture');
    return git('rev-parse', '--verify', 'HEAD');
  };
  return { repository, git, commit };
}

describe('measurementRuntimeDigest', () => {
  it.each(assets.map(([path]) => [path]))('includes changed bytes of the regular asset %s', path => {
    const root = runtimeFixture(), before = measurementRuntimeDigest(root);
    appendFileSync(join(root, path), '\nchanged runtime bytes\n');
    expect(measurementRuntimeDigest(root)).not.toBe(before);
  });

  it('includes regular asset additions, deletions and relative path identities', () => {
    const root = runtimeFixture(), before = measurementRuntimeDigest(root);
    expect(before).toMatch(/^sha256:[a-f0-9]{64}$/);
    writeAsset(root, 'assets/empty', '');
    expect(measurementRuntimeDigest(root)).not.toBe(before);
    rmSync(join(root, 'assets/empty'));
    expect(measurementRuntimeDigest(root)).toBe(before);
    renameSync(join(root, 'cli/main.js'), join(root, 'cli/renamed.js'));
    expect(measurementRuntimeDigest(root)).not.toBe(before);
  });

  it('distinguishes embedded NUL bytes in an asset from additional path and content records', () => {
    const first = runtimeFixture([['a.bin', Buffer.from('x\0b.txt\0y')]]);
    const second = runtimeFixture([['a.bin', 'x'], ['b.txt', 'y']]);
    expect(measurementRuntimeDigest(first)).not.toBe(measurementRuntimeDigest(second));
  });

  it('ignores creation, arbitrary nested changes and deletion of the Studio web subtree', () => {
    const root = runtimeFixture(), before = measurementRuntimeDigest(root);
    const webAssets = ['studio/web/index.html', 'studio/web/.next/static/chunks/client.js', 'studio/web/arbitrary/deep/build-id'];
    for (const path of webAssets) writeAsset(root, path, 'initial web build');
    expect(measurementRuntimeDigest(root)).toBe(before);
    for (const path of webAssets) appendFileSync(join(root, path), '\nnew nondeterministic build');
    writeAsset(root, 'studio/web/new/deeper/asset.bin', Buffer.from([255, 0]));
    expect(measurementRuntimeDigest(root)).toBe(before);
    rmSync(join(root, 'studio/web'), { recursive: true });
    expect(measurementRuntimeDigest(root)).toBe(before);
  });

  it.each(['studio/web.js', 'studio/web-adjacent/server.js', 'plugins/studio/web/index.html'])('still includes the non-excluded path %s', path => {
    const root = runtimeFixture(), before = measurementRuntimeDigest(root);
    writeAsset(root, path, 'included runtime asset');
    expect(measurementRuntimeDigest(root)).not.toBe(before);
  });

  it('excludes a symlinked Studio web directory without following its target', () => {
    const root = runtimeFixture(), target = temporaryRoot(), before = measurementRuntimeDigest(root);
    mkdirSync(join(root, 'studio')); writeAsset(target, 'index.html', 'unrelated web build');
    symlinkSync(target, join(root, 'studio/web'), 'dir');
    expect(measurementRuntimeDigest(root)).toBe(before);
    appendFileSync(join(target, 'index.html'), '\nchanged');
    symlinkSync(join(target, 'missing'), join(target, 'dangling'), 'file');
    expect(measurementRuntimeDigest(root)).toBe(before);
  });

  it.each(['file', 'directory', 'dangling'] as const)('rejects a non-excluded %s symlink', kind => {
    const root = runtimeFixture(), target = temporaryRoot();
    writeAsset(target, 'asset.json', '{}');
    const destination = join(root, 'assets/linked');
    symlinkSync(kind === 'directory' ? target : join(target, kind === 'file' ? 'asset.json' : 'missing'), destination,
      kind === 'directory' ? 'dir' : 'file');
    expect(() => measurementRuntimeDigest(root)).toThrow('Measurement runtime must contain regular files only.');
  });

  it('is independent of creation and directory enumeration order', () => {
    const first = runtimeFixture(), second = runtimeFixture([...assets].reverse());
    const expected = measurementRuntimeDigest(first);
    expect(measurementRuntimeDigest(second)).toBe(expected);
    const original = fs.readdirSync;
    const reversed = ((...args: Parameters<typeof fs.readdirSync>) => original(...args).reverse()) as typeof fs.readdirSync;
    const enumeration = vi.spyOn(fs, 'readdirSync').mockImplementation(reversed);
    try {
      syncBuiltinESMExports();
      expect(measurementRuntimeDigest(first)).toBe(expected);
      expect(measurementRuntimeDigest(second)).toBe(expected);
    } finally { enumeration.mockRestore(); syncBuiltinESMExports(); }
  });
});

describe('reviewSourceRevision', () => {
  it.each([
    { label: 'a non-Git directory', initialize: false },
    { label: 'an initialized repository without HEAD', initialize: true },
  ])('returns unknown for $label', ({ initialize }) => {
    const f = gitFixture(initialize);
    expect(reviewSourceRevision(f.repository)).toEqual({ commit: null, dirty: null });
  });

  it('records the actual commit and a clean tracked checkout', () => {
    const f = gitFixture(), commit = f.commit();
    expect(reviewSourceRevision(f.repository)).toEqual({ commit, dirty: false });
  });

  it.each(['unstaged tracked', 'staged tracked', 'untracked'] as const)('records the same commit and dirty state for %s changes', kind => {
    const f = gitFixture(), commit = f.commit();
    writeAsset(f.repository, kind === 'untracked' ? 'new/untracked.txt' : 'runtime.js', 'changed bytes\n');
    if (kind === 'staged tracked') f.git('add', '--', 'runtime.js');
    expect(reviewSourceRevision(f.repository)).toEqual({ commit, dirty: true });
  });

  it('does not inherit the enclosing repository revision for an installed package directory', () => {
    const f = gitFixture(), commit = f.commit(), installed = join(f.repository, 'node_modules/oh-my-knowledge');
    writeAsset(installed, 'package.json', '{"name":"oh-my-knowledge"}');
    expect(reviewSourceRevision(f.repository)).toEqual({ commit, dirty: false });
    expect(reviewSourceRevision(installed)).toEqual({ commit: null, dirty: null });
  });
});
