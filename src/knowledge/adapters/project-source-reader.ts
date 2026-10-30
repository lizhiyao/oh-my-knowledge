import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { canonicalJson } from '../store.js';
import { ResolvedSourceSelectionSchema, SOURCE_PROJECTION_VERSION, SourceMaterialAttributionSchema,
  SourceProjectionSchema, SourceSelectionSchema, resolveSourceLineRanges, sourceVersionPreimage,
  type ResolvedSourceSelection, type SourceLineRange, type SourceMaterialAttribution,
  type SourceProjection, type SourceProvenance, type SourceSelection } from '../sources.js';

export const PROJECT_SOURCE_MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_GIT_METADATA_BYTES = 128 * 1024;
type ProjectSelection = Extract<SourceSelection, { sourceKind: 'project_file' | 'git_blob' }>;
type ResolvedProjectSelection = Extract<ResolvedSourceSelection, { sourceKind: 'project_file' | 'git_blob' }>;
type GitIdentity = Extract<SourceProjection, { sourceKind: 'git_blob' }>['identity'];
type ReadFailure = 'missing' | 'permission_denied' | 'unsupported' | 'version_mismatch';

export class ProjectSourceReadError extends Error {
  constructor(readonly reason: ReadFailure, message: string) { super(message); this.name = 'ProjectSourceReadError'; }
}
/** The application constructs this binding; browser/model payloads cannot authorize a filesystem root. */
export interface ProjectSourceReadContext {
  projectId: string; approvedRoot: string; material?: SourceMaterialAttribution; signal?: AbortSignal;
}
export interface ProjectSourceReading {
  projection: SourceProjection; sourceVersion: string; resolvedSelection: ResolvedProjectSelection;
  readManifest: { contentBytes: number; metadataBytes: number; totalBytes: number; selectedTextBytes: number };
}
const digest = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function unsupported(message: string): never { throw new ProjectSourceReadError('unsupported', message); }
function mismatch(): never { throw new ProjectSourceReadError('version_mismatch', 'Source changed while it was being read; preview it again.'); }
const unknownMaterial: SourceMaterialAttribution = { materialType: 'unknown', attributionBasis: 'unknown',
  reason: 'The host did not declare a material type; file names and extensions do not establish execution evidence.' };
const converterExtension = /\.(?:pdf|docx?|odt|pptx?|odp|xlsx?|ods|png|jpe?g|gif|webp|heic|avif|ico|zip|gz|bz2|xz|7z|rar|tar|woff2?|ttf|otf|mp[34]|m4a|wav|mov|avi|wasm|exe|dll|dylib|so)$/iu;

function exactText(bytes: Uint8Array, relativePath: string): string {
  if (converterExtension.test(extname(relativePath))) unsupported('This file requires a format-specific converter; select a UTF-8 text source.');
  if (bytes.length >= 5 && Buffer.from(bytes.buffer, bytes.byteOffset, 5).toString('ascii') === '%PDF-') {
    unsupported('PDF source content requires a format-specific converter.');
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return unsupported('Source is not valid UTF-8 text.'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) unsupported('Binary/control-byte source content is unsupported.');
  return text;
}
function rootBinding(context: ProjectSourceReadContext, selection: ProjectSelection | ResolvedProjectSelection): string {
  if (context.projectId !== selection.projectId) unsupported('Selected project does not match the trusted root binding.');
  if (!isAbsolute(context.approvedRoot) || /[\u0000-\u001f\u007f]/u.test(context.approvedRoot)) unsupported('An explicit absolute project root is required.');
  const root = realpathSync(context.approvedRoot);
  if (!lstatSync(root).isDirectory()) unsupported('Select one existing project directory.');
  return root;
}
function safeFile(root: string, relativePath: string): { path: string; stat: BigIntStats } {
  let path = root;
  const parts = relativePath.split('/');
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      unsupported('Selected paths must contain only directories and a regular text file; symbolic links are unsupported.');
    }
  }
  const canonical = realpathSync(path), within = relative(root, canonical);
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) unsupported('Selected file escapes the approved project root.');
  return { path: canonical, stat: lstatSync(canonical, { bigint: true }) };
}
const sameFile = (a: BigIntStats, b: BigIntStats) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function fileBytes(root: string, relativePath: string, signal?: AbortSignal): Buffer {
  const selected = safeFile(root, relativePath);
  if (selected.stat.size > BigInt(PROJECT_SOURCE_MAX_READ_BYTES)) unsupported('Selected file exceeds the 16 MiB read capacity.');
  let fd: number | undefined;
  try {
    fd = openSync(selected.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFile(selected.stat, opened)) mismatch();
    // One extra byte detects growth without reading an unbounded replacement file.
    const bytes = Buffer.allocUnsafe(Number(opened.size) + 1); let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    signal?.throwIfAborted();
    if (offset !== Number(opened.size) || !sameFile(opened, fstatSync(fd, { bigint: true }))) mismatch();
    const after = safeFile(root, relativePath);
    if (after.path !== selected.path || !sameFile(opened, after.stat)) mismatch();
    return bytes.subarray(0, offset);
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** A final newline belongs to its preceding line; an empty file has no selected text lines. */
function lineSpans(bytes: Buffer): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = []; let start = 0;
  for (let position = 0; position < bytes.length; position++) if (bytes[position] === 10) {
    lines.push({ start, end: position + 1 }); start = position + 1;
  }
  if (start < bytes.length) lines.push({ start, end: bytes.length });
  return lines;
}
function selectedRanges(input: readonly SourceLineRange[] | null, total: number, resolved: boolean): SourceLineRange[] {
  if (resolved && input !== null && input.length === 0 && total === 0) return [];
  return resolveSourceLineRanges(input, total);
}
function project(bytes: Buffer, identity: Extract<SourceProjection, { sourceKind: 'project_file' }>['identity'] | GitIdentity,
  sourceKind: 'project_file' | 'git_blob', ranges: SourceLineRange[], material: SourceMaterialAttribution,
  provenance: SourceProvenance): SourceProjection {
  const lines = lineSpans(bytes);
  const rawUnits = ranges.map((range, unitId) => {
    const startByte = lines[range.startLine - 1].start, endByte = lines[range.endLine - 1].end;
    const selected = bytes.subarray(startByte, endByte);
    const fixedIdentity = identity as GitIdentity;
    const coordinate = sourceKind === 'git_blob'
      ? { coordinateKind: 'git_blob_range' as const, relativePath: identity.relativePath,
        objectHashAlgorithm: fixedIdentity.objectHashAlgorithm, commitOid: fixedIdentity.commitOid,
        treeOid: fixedIdentity.treeOid, blobOid: fixedIdentity.blobOid, ...range, startByte, endByte }
      : { coordinateKind: 'file_range' as const, relativePath: identity.relativePath, ...range, startByte, endByte };
    return { unitId, coordinate, text: exactText(selected, identity.relativePath),
      rawByteDigest: digest(selected), rawByteLength: selected.length };
  });
  return SourceProjectionSchema.parse({ projectionVersion: SOURCE_PROJECTION_VERSION, sourceKind, identity,
    selection: { lineRanges: ranges }, contentVersion: digest(bytes), material, provenance, rawUnits,
    excerpts: rawUnits.map(unit => ({ unitId: unit.unitId, coordinate: unit.coordinate, text: unit.text, material })),
    limitations: ['Selected UTF-8 text only; reading source text does not prove its claims or that any described test or execution occurred.'] });
}
function childEnvironment(): NodeJS.ProcessEnv {
  // Parent Git routing, tracing and alternate-object variables must not redirect an approved project read.
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) as NodeJS.ProcessEnv,
    LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' };
}
function gitReader(root: string, signal?: AbortSignal) {
  const env = childEnvironment(); let metadataBytes = 0;
  const run = (args: string[], label: string, maxBuffer = MAX_GIT_METADATA_BYTES, content = false): Buffer => {
    signal?.throwIfAborted();
    let bytes: Buffer;
    try {
      bytes = execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', '--literal-pathspecs', '--no-optional-locks',
        '--no-pager', '-C', root, ...args], { env, encoding: 'buffer', stdio: 'pipe', timeout: 10_000, maxBuffer, windowsHide: true });
    } catch (error) {
      const detail = error as NodeJS.ErrnoException & { stderr?: Buffer };
      const diagnostic = detail.stderr?.toString('utf8') ?? '';
      if (detail.code === 'ENOENT' || /unknown (?:option|global option)[^\n]*no-lazy-fetch/u.test(diagnostic)) {
        return unsupported('Local Git with the --no-lazy-fetch capability is required; no remote fallback is permitted.');
      }
      if (detail.code === 'EACCES' || detail.code === 'EPERM') throw new ProjectSourceReadError('permission_denied', 'Local Git source permission was denied.');
      if (detail.code === 'ENOBUFS') return unsupported('Git source output exceeds its bounded read capacity.');
      throw new ProjectSourceReadError('missing', `Selected ${label} is not available in the approved local Git repository.`);
    }
    signal?.throwIfAborted();
    if (!content) metadataBytes += bytes.length;
    return bytes;
  };
  const line = (args: string[], label: string) => {
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(run(args, label));
    if (!value.endsWith('\n') || value.slice(0, -1).includes('\n')) unsupported('Git returned an invalid metadata line.');
    return value.slice(0, -1);
  };
  return { run, line, metadataBytes: () => metadataBytes };
}
function fixedGit(selection: Extract<ProjectSelection | ResolvedProjectSelection, { sourceKind: 'git_blob' }>, root: string,
  signal?: AbortSignal): { bytes: Buffer; identity: GitIdentity; provenance: SourceProvenance; metadataBytes: number } {
  const git = gitReader(root, signal);
  if (realpathSync(git.line(['rev-parse', '--path-format=absolute', '--show-toplevel'], 'repository root')) !== root) {
    unsupported('The trusted Git binding must select the repository worktree root.');
  }
  const objectHashAlgorithm = git.line(['rev-parse', '--show-object-format'], 'object format');
  if (objectHashAlgorithm !== 'sha1' && objectHashAlgorithm !== 'sha256') unsupported('Unsupported Git object hash algorithm.');
  const oidLength = objectHashAlgorithm === 'sha1' ? 40 : 64, validOid = (value: string) => new RegExp(`^[a-f0-9]{${oidLength}}$`, 'u').test(value);
  const revision = 'revision' in selection ? selection.revision : selection.commitOid;
  const commitOid = git.line(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], 'commit');
  const treeOid = git.line(['rev-parse', '--verify', '--end-of-options', `${commitOid}^{tree}`], 'tree');
  if (!validOid(commitOid) || !validOid(treeOid)) unsupported('Git returned an invalid fixed object identity.');
  const entry = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(git.run(['ls-tree', '--full-tree', '-z', treeOid, '--', selection.relativePath], 'file entry'));
  if (!entry) throw new ProjectSourceReadError('missing', 'Selected file is absent from the fixed Git tree.');
  const tab = entry.indexOf('\t'), header = entry.slice(0, tab), path = entry.slice(tab + 1, -1);
  const match = /^(100644|100755) blob ([a-f0-9]+)$/u.exec(header);
  if (!entry.endsWith('\0') || path.includes('\0') || path !== selection.relativePath || !match || !validOid(match[2])) {
    unsupported('Select one literal regular Git blob; trees, links and gitlinks are unsupported.');
  }
  const identity: GitIdentity = { projectId: selection.projectId, relativePath: selection.relativePath,
    objectHashAlgorithm, commitOid, treeOid, blobOid: match[2] };
  if (!('revision' in selection) && ['objectHashAlgorithm', 'commitOid', 'treeOid', 'blobOid'].some(key =>
    identity[key as keyof GitIdentity] !== selection[key as keyof typeof selection])) mismatch();
  const sizeText = git.line(['cat-file', '-s', identity.blobOid], 'blob size');
  if (!/^\d+$/u.test(sizeText) || !Number.isSafeInteger(Number(sizeText))) unsupported('Invalid Git blob size.');
  const size = Number(sizeText);
  if (size > PROJECT_SOURCE_MAX_READ_BYTES) unsupported('Selected Git blob exceeds the 16 MiB read capacity.');
  const metadata = git.run(['show', '--no-patch', '--no-show-signature', '--no-notes', '--no-decorate', '--encoding=UTF-8',
    '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00', commitOid, '--'], 'commit attribution');
  const fields = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(metadata).split('\0');
  if (fields.length !== 7 || fields[6] !== '\n') unsupported('Git returned invalid source attribution.');
  const [author, authorEmail, authorAt, committer, committerEmail, committerAt] = fields;
  const provenance: SourceProvenance = {
    attributions: [{ role: 'author', name: `${author} <${authorEmail}>`, basis: 'source_declared' },
      { role: 'producer', name: `${committer} <${committerEmail}>`, basis: 'source_declared' }],
    times: [{ timeKind: 'git_author', at: authorAt, basis: 'source_declared' },
      { timeKind: 'git_committer', at: committerAt, basis: 'source_declared' }],
  };
  const bytes = git.run(['cat-file', 'blob', identity.blobOid], 'blob', Math.max(size + 1, 1024), true);
  if (bytes.length !== size) mismatch();
  return { bytes, identity, provenance, metadataBytes: git.metadataBytes() };
}
function read(selection: ProjectSelection | ResolvedProjectSelection, context: ProjectSourceReadContext, resolved: boolean): ProjectSourceReading {
  context.signal?.throwIfAborted();
  try {
    const root = rootBinding(context, selection), material = SourceMaterialAttributionSchema.parse(context.material ?? unknownMaterial);
    const source = selection.sourceKind === 'project_file'
      ? { bytes: fileBytes(root, selection.relativePath, context.signal), identity: { projectId: selection.projectId, relativePath: selection.relativePath },
        provenance: { attributions: [], times: [] } as SourceProvenance, metadataBytes: 0 }
      : fixedGit(selection, root, context.signal);
    exactText(source.bytes, selection.relativePath);
    const ranges = selectedRanges(selection.lineRanges, lineSpans(source.bytes).length, resolved);
    const projection = project(source.bytes, source.identity, selection.sourceKind, ranges, material, source.provenance);
    const resolvedSelection = ResolvedSourceSelectionSchema.parse({ sourceKind: projection.sourceKind, ...projection.identity, ...projection.selection });
    if (resolvedSelection.sourceKind === 'agent_trace') return unsupported('Project readers do not parse trace sources.');
    return { projection, sourceVersion: digest(canonicalJson(sourceVersionPreimage(projection))), resolvedSelection,
      readManifest: { contentBytes: source.bytes.length, metadataBytes: source.metadataBytes,
        totalBytes: source.bytes.length + source.metadataBytes,
        selectedTextBytes: projection.rawUnits.reduce((sum, unit) => sum + unit.rawByteLength, 0) } };
  } catch (error) {
    if (error instanceof ProjectSourceReadError || context.signal?.aborted) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw new ProjectSourceReadError('permission_denied', 'Project source permission was denied.');
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new ProjectSourceReadError('missing', 'Selected project source is missing.');
    return unsupported('Invalid or unsupported project source selection.');
  }
}
/** Resolve an explicit user selection; null ranges mean all lines and [] is never an implicit all-files grant. */
export function readProjectSource(input: ProjectSelection, context: ProjectSourceReadContext): ProjectSourceReading {
  const selection = SourceSelectionSchema.parse(input);
  if (selection.sourceKind === 'agent_trace') return unsupported('Project readers do not parse trace sources.');
  return read(selection, context, false);
}
/** Revalidate a preview's exact fixed objects/ranges; moving branch names cannot alter this read. */
export function readResolvedProjectSource(input: ResolvedProjectSelection, context: ProjectSourceReadContext): ProjectSourceReading {
  const selection = ResolvedSourceSelectionSchema.parse(input);
  if (selection.sourceKind === 'agent_trace') return unsupported('Project readers do not parse trace sources.');
  return read(selection, context, true);
}
