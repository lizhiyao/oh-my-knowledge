import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { SourceCaptureError, SourceCaptureService, type SourceCapturePorts } from './source-capture.js';
import { canonicalJson } from '../store.js';
import { SourceMaterialAttributionSchema, SourceNamespaceSchema, SourceRelativePathSchema, type ResolvedSourceSelection,
  type SourceMaterialAttribution, type SourceSelection } from '../sources.js';
import { readProjectSource, readResolvedProjectSource } from '../adapters/project-source-reader.js';
import { readTraceSource } from '../adapters/trace-source-reader.js';
import { FileSourceStore } from '../adapters/source-store.js';

const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value), 'Explicit absolute host path required.');
const material = z.strictObject({ materialType: SourceMaterialAttributionSchema.shape.materialType, reason: z.string().trim().min(1).max(4096) });
const project = z.strictObject({ projectId: SourceNamespaceSchema, root: absolutePath,
  materials: z.array(material.extend({ relativePath: SourceRelativePathSchema })).max(4096).optional() });
const trace = z.strictObject({ sourceId: SourceNamespaceSchema, traceKind: z.string().min(1).max(256), path: absolutePath,
  origin: z.strictObject({ threadId: z.string().min(1).max(256), turnId: z.string().min(1).max(256).optional(), title: z.string().max(4096) }).optional(), material: material.optional() });
/** Trusted startup/CLI configuration only. Browser or model selectors cannot construct filesystem bindings. */
export const LocalSourceScopeSchema = z.strictObject({ scopeVersion: z.literal('knowledge-source-scope/v1'),
  projects: z.array(project).max(256), traces: z.array(trace).max(256) }).superRefine((scope, context) => {
  const unique = (values: string[], path: (string | number)[]) => { if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', path, message: 'Duplicate trusted source binding.' }); };
  unique(scope.projects.map(value => value.projectId), ['projects']); unique(scope.traces.map(value => value.sourceId), ['traces']);
  scope.projects.forEach((value, index) => unique((value.materials ?? []).map(item => item.relativePath), ['projects', index, 'materials']));
});
export type LocalSourceScope = z.infer<typeof LocalSourceScopeSchema>;
/** The scope file is an explicit host input, never a browser path. */
export function readLocalSourceScope(path: string): LocalSourceScope {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024n * 1024n) throw new Error('Trusted source scope must be a regular UTF-8 JSON file within 1 MiB.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }), buffer = Buffer.allocUnsafe(Number(before.size) + 1); let offset = 0;
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('Trusted source scope binding changed.');
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, null); if (!count) break; offset += count; }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (offset !== Number(before.size) || [after, named].some(stat => stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size
      || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs || !stat.isFile() || stat.isSymbolicLink())) throw new Error('Trusted source scope changed during read.');
    return LocalSourceScopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))));
  } finally { closeSync(fd); }
}
function declared(value: z.infer<typeof material> | undefined): SourceMaterialAttribution | undefined {
  return value && { materialType: value.materialType, attributionBasis: 'host_declared', reason: value.reason };
}
function binding(path: string, directory: boolean) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Invalid binding.');
    return { path: realpathSync(path), device: stat.dev.toString(), inode: stat.ino.toString() };
  } catch { throw new SourceCaptureError('scope_changed', 'A trusted source binding is unavailable or changed; select and preview it again.'); }
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** No discovery, persisted permission registry or model execution. Paths stay inside this trusted reader closure. */
export function createLocalSourceReader(input: LocalSourceScope): Pick<SourceCapturePorts, 'read' | 'readResolved' | 'currentScopeRevision'> {
  const scope = LocalSourceScopeSchema.parse(input);
  const current = () => ({ scopeVersion: scope.scopeVersion,
    projects: scope.projects.map(value => ({ ...value, materials: [...(value.materials ?? [])].sort((a, b) => compare(a.relativePath, b.relativePath)),
      binding: binding(value.root, true) })).sort((a, b) => compare(a.projectId, b.projectId)),
    traces: scope.traces.map(value => ({ ...value, binding: binding(value.path, false) })).sort((a, b) => compare(a.sourceId, b.sourceId)) });
  const read = (selection: SourceSelection | ResolvedSourceSelection, fixed: boolean, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (selection.sourceKind === 'agent_trace') {
      const selected = scope.traces.find(value => value.sourceId === selection.sourceId && value.traceKind === selection.traceKind);
      if (!selected) throw new Error('Selected trace has no explicit trusted host binding.');
      return readTraceSource(selection, { sourceId: selected.sourceId, traceKind: selected.traceKind,
        source: { sourceType: 'file', approvedPath: binding(selected.path, false).path }, origin: selected.origin, material: declared(selected.material), signal });
    }
    const selected = scope.projects.find(value => value.projectId === selection.projectId);
    if (!selected) throw new Error('Selected project has no explicit trusted host binding.');
    const context = { projectId: selected.projectId, approvedRoot: binding(selected.root, true).path,
      material: declared(selected.materials?.find(value => value.relativePath === selection.relativePath)), signal };
    return fixed ? readResolvedProjectSource(selection as Extract<ResolvedSourceSelection, { sourceKind: 'project_file' | 'git_blob' }>, context)
      : readProjectSource(selection as Extract<SourceSelection, { sourceKind: 'project_file' | 'git_blob' }>, context);
  };
  return { currentScopeRevision: () => `sha256:${createHash('sha256').update(canonicalJson(current())).digest('hex')}`,
    read: (selection, signal) => read(selection, false, signal), readResolved: (selection, signal) => read(selection, true, signal) };
}
export function createLocalSourceCapture(workspace: string, input: LocalSourceScope): SourceCaptureService {
  if (!workspace.trim()) throw new Error('Explicit source workspace required.');
  return new SourceCaptureService({ ...createLocalSourceReader(input), store: new FileSourceStore(resolve(workspace, 'sources'), resolve(workspace)) });
}
