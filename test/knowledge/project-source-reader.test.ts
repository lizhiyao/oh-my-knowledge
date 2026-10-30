import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_SOURCE_MAX_READ_BYTES, ProjectSourceReadError, readProjectSource,
  readResolvedProjectSource } from '../../src/knowledge/adapters/project-source-reader.js';
import type { SourceSelection } from '../../src/knowledge/sources.js';

const readFault = vi.hoisted(() => ({ afterRead: undefined as ((fd: number) => void) | undefined }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null) {
    const count = fs.readSync(fd, buffer, offset, length, position), hook = readFault.afterRead;
    readFault.afterRead = undefined; hook?.(fd); return count;
  } };
});
const roots: string[] = [];
const fixtureControls = new Map<string, { hooks: string; templates: string }>();
afterEach(() => {
  readFault.afterRead = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks();
  fixtureControls.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'omk-project-reader-')); roots.push(root); return root; };
const context = (root: string) => ({ projectId: 'authored-project', approvedRoot: root });
const file = (relativePath: string, lineRanges: Extract<SourceSelection, { sourceKind: 'project_file' }>['lineRanges'] = null) => ({
  sourceKind: 'project_file' as const, projectId: 'authored-project', relativePath, lineRanges,
});
function put(root: string, relativePath: string, content: string | Buffer) {
  const path = join(root, relativePath); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path;
}
type FixtureIdentity = { name?: string; email?: string; authorDate?: string; committerDate?: string };
function git(root: string, args: string[], identity: FixtureIdentity = {}): string {
  let controls = fixtureControls.get(root);
  if (!controls) {
    const directory = temp(); controls = { hooks: join(directory, 'hooks'), templates: join(directory, 'templates') };
    mkdirSync(controls.hooks); mkdirSync(controls.templates); fixtureControls.set(root, controls);
  }
  // -C does not override GIT_DIR, GIT_INDEX_FILE or object routing. Mutating fixtures must never inherit them.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-C', root, '-c', `core.hooksPath=${controls.hooks}`, '-c', `init.templateDir=${controls.templates}`,
    '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], {
    encoding: 'utf8', stdio: 'pipe', env: { ...environment, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull, GIT_ATTR_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: identity.name ?? 'Authored Fixture', GIT_AUTHOR_EMAIL: identity.email ?? 'fixture@example.invalid',
      GIT_COMMITTER_NAME: identity.name ?? 'Authored Fixture', GIT_COMMITTER_EMAIL: identity.email ?? 'fixture@example.invalid',
      GIT_AUTHOR_DATE: identity.authorDate ?? '2026-10-29T12:34:56+08:00',
      GIT_COMMITTER_DATE: identity.committerDate ?? '2026-10-29T12:35:56+08:00' } }).trim();
}
function commit(root: string, message: string, identity?: FixtureIdentity) {
  git(root, ['add', '--all']);
  git(root, ['commit', '-qm', message], identity);
  return git(root, ['rev-parse', 'HEAD']);
}
function repository(format: 'sha1' | 'sha256' = 'sha1', identity?: FixtureIdentity) {
  const root = temp(); git(root, ['init', '-q', '-b', 'main', `--object-format=${format}`]);
  put(root, 'docs/input.txt', 'first\r\nsecond\r\nlast');
  const initial = commit(root, 'authored initial source', identity); return { root, initial };
}
function gitCustody(root: string) {
  const directory = join(root, '.git/objects'), objects: { path: string; digest: string }[] = [];
  const walk = (path: string) => { for (const name of readdirSync(path).sort()) {
    const item = join(path, name); if (lstatSync(item).isDirectory()) walk(item);
    else objects.push({ path: relative(directory, item), digest: sha(readFileSync(item)) });
  } }; walk(directory);
  return { head: git(root, ['rev-parse', 'HEAD']), index: sha(readFileSync(join(root, '.git/index'))), objects };
}
const blob = (relativePath = 'docs/input.txt', revision = 'main') => ({
  sourceKind: 'git_blob' as const, projectId: 'authored-project', relativePath, revision, lineRanges: null,
});

describe('bounded project file and fixed Git source readers', () => {
  it('preserves exact BOM, CRLF, astral bytes and disjoint line coordinates without synthetic separators', () => {
    const root = temp(), bytes = Buffer.from('\uFEFF甲😀\r\nsecond\r\nlast');
    put(root, 'docs/source.txt', bytes);
    const input = file('docs/source.txt', [{ startLine: 3, endLine: 3 }, { startLine: 1, endLine: 1 }, { startLine: 1, endLine: 1 }]);
    const result = readProjectSource(input, context(root));
    expect(result.resolvedSelection.lineRanges).toEqual([{ startLine: 1, endLine: 1 }, { startLine: 3, endLine: 3 }]);
    expect(result.projection.contentVersion).toBe(sha(bytes));
    expect(result.projection.rawUnits.map(unit => ({ text: unit.text, coordinate: unit.coordinate, length: unit.rawByteLength }))).toEqual([
      { text: '\uFEFF甲😀\r\n', coordinate: { coordinateKind: 'file_range', relativePath: 'docs/source.txt', startLine: 1, endLine: 1, startByte: 0, endByte: 12 }, length: 12 },
      { text: 'last', coordinate: { coordinateKind: 'file_range', relativePath: 'docs/source.txt', startLine: 3, endLine: 3, startByte: 20, endByte: 24 }, length: 4 },
    ]);
    expect(result.projection.excerpts.map(excerpt => excerpt.text)).toEqual(['\uFEFF甲😀\r\n', 'last']);
    expect(result.projection.rawUnits.map(unit => unit.rawByteDigest)).toEqual([sha(bytes.subarray(0, 12)), sha(bytes.subarray(20, 24))]);
    expect(result.readManifest).toEqual({ contentBytes: 24, metadataBytes: 0, totalBytes: 24, selectedTextBytes: 16 });
    expect(JSON.stringify(result.projection)).not.toContain(root);
  });

  it('keeps identical text/selection stable across host roots and changes the version for unselected bytes or declared material', () => {
    const first = temp(), second = temp(); put(first, 'rules.test.ts', 'kept\nold'); put(second, 'rules.test.ts', 'kept\nold');
    const input = file('rules.test.ts', [{ startLine: 1, endLine: 1 }]);
    const baseline = readProjectSource(input, context(first)), copy = readProjectSource(input, context(second));
    expect(copy.sourceVersion).toBe(baseline.sourceVersion);
    expect(baseline.projection.material.materialType).toBe('unknown');
    expect(baseline.projection.provenance).toEqual({ attributions: [], times: [] });
    put(second, 'rules.test.ts', 'kept\nnew');
    const changed = readProjectSource(input, context(second));
    expect(changed.projection.excerpts).toEqual(baseline.projection.excerpts);
    expect(changed.sourceVersion).not.toBe(baseline.sourceVersion);
    const declared = readProjectSource(input, { ...context(first), material: { materialType: 'test_expectation',
      attributionBasis: 'host_declared', reason: 'Authored test source, not a record that it executed.' } });
    expect(declared.sourceVersion).not.toBe(baseline.sourceVersion);
    expect(declared.projection.material.materialType).toBe('test_expectation');
    expect(declared.projection.provenance.times).toEqual([]);
  });

  it('resolves explicit whole-file empty and final-newline selections without inventing an extra line', () => {
    const root = temp(); put(root, 'empty', ''); put(root, 'newline', 'line\n');
    const empty = readProjectSource(file('empty'), context(root));
    expect(empty.projection).toMatchObject({ contentVersion: sha(''), selection: { lineRanges: [] }, rawUnits: [], excerpts: [] });
    expect(readResolvedProjectSource(empty.resolvedSelection, context(root)).sourceVersion).toBe(empty.sourceVersion);
    const newline = readProjectSource(file('newline'), context(root));
    expect(newline.resolvedSelection.lineRanges).toEqual([{ startLine: 1, endLine: 1 }]);
    expect(newline.projection.excerpts[0].text).toBe('line\n');
    expect(() => readProjectSource(file('newline', []), context(root))).toThrow();
    expect(() => readProjectSource(file('newline', [{ startLine: 2, endLine: 2 }]), context(root))).toThrow(ProjectSourceReadError);
  });

  it('rejects traversal, root mismatch, links, nonregular files, binary/invalid UTF-8 and converters before returning material', () => {
    const root = temp(), outside = temp(); put(root, 'safe.txt', 'safe'); const target = put(outside, 'outside.txt', 'not authorized');
    symlinkSync(target, join(root, 'link.txt')); symlinkSync(outside, join(root, 'linked-directory'));
    for (const relativePath of ['../outside.txt', '/absolute', 'safe/../safe.txt', 'linked-directory/outside.txt', 'link.txt', '.']) {
      expect(() => readProjectSource(file(relativePath), context(root))).toThrow();
    }
    mkdirSync(join(root, 'directory'));
    expect(() => readProjectSource(file('directory'), context(root))).toThrow(ProjectSourceReadError);
    expect(() => readProjectSource(file('safe.txt'), { ...context(root), projectId: 'other-project' })).toThrow(ProjectSourceReadError);
    for (const [name, bytes] of [['nul.txt', Buffer.from([65, 0, 66])], ['invalid.txt', Buffer.from([0xff])],
      ['input.pdf', Buffer.from('%PDF-1.7')], ['renamed.txt', Buffer.from('%PDF-1.7')]] as const) {
      put(root, name, bytes); expect(() => readProjectSource(file(name), context(root))).toThrow(ProjectSourceReadError);
    }
    const large = put(root, 'large.txt', ''); truncateSync(large, PROJECT_SOURCE_MAX_READ_BYTES + 1);
    expect(() => readProjectSource(file('large.txt'), context(root))).toThrow('16 MiB');
    expect(() => readProjectSource(file('missing.txt'), context(root))).toThrow(expect.objectContaining({ reason: 'missing' }));
  });

  it.each(['change', 'abort'] as const)('closes the opened descriptor after %s during the bounded read', failure => {
    const root = temp(), path = put(root, 'read.txt', 'original'), cancellation = new AbortController(); let descriptor: number | undefined;
    readFault.afterRead = fd => { descriptor = fd;
      if (failure === 'change') appendFileSync(path, 'changed'); else cancellation.abort(new Error('authored cancellation'));
    };
    expect(() => readProjectSource(file('read.txt'), { ...context(root), signal: cancellation.signal })).toThrow(failure === 'change'
      ? expect.objectContaining({ reason: 'version_mismatch' }) : 'authored cancellation');
    expect(descriptor).toBeTypeOf('number'); expect(() => fstatSync(descriptor!)).toThrow(expect.objectContaining({ code: 'EBADF' }));
    readFault.afterRead = undefined;
    expect(readProjectSource(file('read.txt'), context(root)).projection.excerpts[0].text).toBe(failure === 'change' ? 'originalchanged' : 'original');
  });

  it.each(['sha1', 'sha256'] as const)('pins literal %s Git objects and original attribution across dirty worktree and moving branch state', format => {
    const { root, initial } = repository(format), original = readProjectSource(blob(), context(root));
    expect(original.projection.sourceKind).toBe('git_blob');
    if (original.projection.sourceKind !== 'git_blob') throw Error('Git projection expected');
    expect(original.projection.identity).toMatchObject({ objectHashAlgorithm: format, commitOid: initial });
    expect(original.projection.identity.blobOid).toHaveLength(format === 'sha1' ? 40 : 64);
    expect(original.projection.provenance.attributions).toEqual([
      { role: 'author', name: 'Authored Fixture <fixture@example.invalid>', basis: 'source_declared' },
      { role: 'producer', name: 'Authored Fixture <fixture@example.invalid>', basis: 'source_declared' },
    ]);
    expect(original.projection.provenance.times.map(time => time.at)).toEqual(['2026-10-29T12:34:56+08:00', '2026-10-29T12:35:56+08:00']);
    expect(original.readManifest.metadataBytes).toBeGreaterThan(0);
    expect(original.readManifest.totalBytes).toBe(original.readManifest.contentBytes + original.readManifest.metadataBytes);
    put(root, 'docs/input.txt', 'dirty bytes are not the selected Git object');
    expect(readProjectSource(blob(), context(root)).sourceVersion).toBe(original.sourceVersion);
    commit(root, 'authored update');
    expect(readResolvedProjectSource(original.resolvedSelection, context(root)).sourceVersion).toBe(original.sourceVersion);
    expect(readProjectSource(blob(), context(root)).sourceVersion).not.toBe(original.sourceVersion);
    expect(readResolvedProjectSource(original.resolvedSelection, context(root)).projection.excerpts[0].text).toBe('first\r\nsecond\r\nlast');
    expect(JSON.stringify(original.projection)).not.toContain(root);
  });

  it('treats pathspec-looking Git names literally and rejects symlink, gitlink, tree and missing identities', () => {
    const { root, initial } = repository();
    put(root, ':(glob)*.txt', 'literal special path'); put(root, 'other.txt', 'not selected');
    symlinkSync('docs/input.txt', join(root, 'link.txt')); commit(root, 'literal names and link');
    expect(readProjectSource(blob(':(glob)*.txt'), context(root)).projection.excerpts[0].text).toBe('literal special path');
    for (const path of ['link.txt', 'docs', 'absent.txt']) expect(() => readProjectSource(blob(path), context(root))).toThrow(ProjectSourceReadError);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${initial},submodule`]);
    git(root, ['-c', 'user.name=Authored Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'authored gitlink']);
    expect(() => readProjectSource(blob('submodule'), context(root))).toThrow(ProjectSourceReadError);
    expect(() => readProjectSource(blob('docs/input.txt', '--not-an-option'), context(root))).toThrow(ProjectSourceReadError);
    const pinned = readProjectSource(blob(), context(root)).resolvedSelection;
    if (pinned.sourceKind !== 'git_blob') throw Error('Git selection expected');
    expect(() => readResolvedProjectSource({ ...pinned, blobOid: 'f'.repeat(40) }, context(root))).toThrow(expect.objectContaining({ reason: 'version_mismatch' }));
  });

  it('isolates fixture init/add/commit and production reads from an outer repository routing and hostile configuration', () => {
    const outer = repository(), hostile = temp(), marker = join(hostile, 'unexpected-program');
    put(outer.root, 'must-stay-untracked.txt', 'This temporary outer file must never be staged by the inner fixture.');
    const before = gitCustody(outer.root);
    const hooks = join(hostile, 'hooks'), templates = join(hostile, 'templates');
    const program = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'invoked');process.exit(91);\n`;
    for (const path of [put(hooks, 'pre-commit', program), put(templates, 'hooks/pre-commit', program)]) chmodSync(path, 0o755);
    const signer = put(hostile, 'signer', program); chmodSync(signer, 0o755);
    const config = put(hostile, 'hostile.gitconfig', `[commit]\n gpgSign = true\n[gpg]\n program = ${JSON.stringify(signer)}\n[core]\n hooksPath = ${JSON.stringify(hooks)}\n[init]\n templateDir = ${JSON.stringify(templates)}\n`);
    const poison = { GIT_DIR: join(outer.root, '.git'), GIT_WORK_TREE: outer.root, GIT_COMMON_DIR: join(outer.root, '.git'),
      GIT_INDEX_FILE: join(outer.root, '.git/index'), GIT_OBJECT_DIRECTORY: join(outer.root, '.git/objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(outer.root, '.git/objects'), GIT_NAMESPACE: 'outer-routing-poison',
      GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_TEMPLATE_DIR: templates,
      GIT_AUTHOR_NAME: 'Inherited Wrong Identity', GIT_COMMITTER_NAME: 'Inherited Wrong Identity',
      GIT_AUTHOR_DATE: 'not-a-date', GIT_COMMITTER_DATE: 'not-a-date',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks };
    for (const [key, value] of Object.entries(poison)) vi.stubEnv(key, value);
    const selected = repository(); put(selected.root, 'docs/input.txt', 'selected repository bytes'); commit(selected.root, 'inner-only update');
    expect(git(selected.root, ['rev-parse', '--show-toplevel'])).toBe(realpathSync(selected.root));
    expect(existsSync(join(selected.root, '.git/hooks/pre-commit'))).toBe(false);
    const source = readProjectSource(blob(), context(selected.root));
    expect(source.projection.excerpts[0].text).toBe('selected repository bytes');
    expect(source.projection.provenance.attributions[0].name).toBe('Authored Fixture <fixture@example.invalid>');
    expect(gitCustody(outer.root)).toEqual(before);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(outer.root, 'must-stay-untracked.txt'), 'utf8')).toContain('must never be staged');
  });

  it('preserves UTF-8 source-declared author identity despite a configured output encoding and mailmap', () => {
    const { root } = repository('sha1', { name: 'José Fixture' });
    const baseline = readProjectSource(blob(), context(root));
    expect(baseline.projection.provenance.attributions[0].name).toBe('José Fixture <fixture@example.invalid>');
    git(root, ['config', 'i18n.logOutputEncoding', 'ISO-8859-1']); git(root, ['config', 'log.mailmap', 'true']);
    put(root, '.mailmap', 'Mapped Person <mapped@example.invalid> José Fixture <fixture@example.invalid>\n');
    const configured = readProjectSource(blob(), context(root));
    expect(configured.projection.provenance).toEqual(baseline.projection.provenance);
    expect(configured.sourceVersion).toBe(baseline.sourceVersion);
  });

  it('returns unsupported when Git cannot enforce no lazy fetch, before any source command succeeds', () => {
    const root = temp(), bin = join(root, 'bin'), record = join(root, 'args.txt'); mkdirSync(bin);
    const shim = put(bin, 'git', `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.slice(2)));process.stderr.write('unknown option: --no-lazy-fetch\\n');process.exit(129);\n`);
    chmodSync(shim, 0o755); vi.stubEnv('PATH', `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => readProjectSource(blob(), context(root))).toThrow(expect.objectContaining({ reason: 'unsupported' }));
    expect(JSON.parse(readFileSync(record, 'utf8'))[0]).toBe('--no-lazy-fetch');
    expect(stderr).not.toHaveBeenCalled();
  });

  it('does not invoke a promisor remote helper or fall back to worktree content when a pinned blob is missing', () => {
    const { root } = repository(), source = readProjectSource(blob(), context(root));
    if (source.projection.sourceKind !== 'git_blob') throw Error('Git projection expected');
    const marker = join(root, 'remote-invoked'), bin = join(root, 'helper-bin'); mkdirSync(bin);
    const helper = put(bin, 'git-remote-omk-offline-fixture', `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'invoked');process.exit(51);\n`); chmodSync(helper, 0o755);
    git(root, ['config', 'remote.origin.url', 'omk-offline-fixture::authored-local-only']);
    git(root, ['config', 'remote.origin.promisor', 'true']); git(root, ['config', 'extensions.partialClone', 'origin']);
    git(root, ['config', 'protocol.omk-offline-fixture.allow', 'always']);
    const oid = source.projection.identity.blobOid; unlinkSync(join(root, '.git/objects', oid.slice(0, 2), oid.slice(2)));
    vi.stubEnv('PATH', `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`);
    expect(() => readResolvedProjectSource(source.resolvedSelection, context(root))).toThrow(expect.objectContaining({ reason: 'missing' }));
    expect(existsSync(marker)).toBe(false); expect(readFileSync(join(root, 'docs/input.txt'), 'utf8')).toBe('first\r\nsecond\r\nlast');
  });
});
