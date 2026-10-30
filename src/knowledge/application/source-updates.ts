import { createHash } from 'node:crypto';
import { z } from 'zod';
import { KnowledgeAssociationCatalogRefSchema } from '../associations.js';
import { KnowledgeBodyRefSchema, type KnowledgeBodyRef } from '../contracts.js';
import type { SourceStore } from '../source-store.js';
import { canonicalJson } from '../store.js';
import { SourceCurrentStateSchema, SourceIdentitySchema, SourceProjectionSchema, SourceRefSchema, SourceResolutionSchema, SourceSelectionSchema,
  normalizeLineRanges, normalizeRecordRanges, sourceSnapshotProjection,
  type SourceCurrentState, type SourceProjection, type SourceRef, type SourceResolution, type SourceSelection, type SourceSnapshot } from '../sources.js';

const id = z.string().min(1).max(256);
const projectionRefSchema = z.strictObject({ namespace: id, bodyRef: KnowledgeBodyRefSchema, projectionRevisionId: id });
export type SourceProjectionRef = z.infer<typeof projectionRefSchema>;
type CatalogRef = z.infer<typeof KnowledgeAssociationCatalogRefSchema>;
const inventorySchema = z.strictObject({ status: z.enum(['complete', 'partial', 'unavailable']),
  bodies: z.array(z.strictObject({ bodyRef: KnowledgeBodyRefSchema, sourceRefs: z.array(SourceRefSchema).max(256) })).max(100_000),
  catalogs: z.array(z.strictObject({ catalogRef: KnowledgeAssociationCatalogRefSchema, sourceRef: SourceRefSchema })).max(100_000),
  projections: z.array(z.strictObject({ projectionRef: projectionRefSchema, sourceRefs: z.array(SourceRefSchema).max(256),
    catalogRefs: z.array(KnowledgeAssociationCatalogRefSchema).max(256) })).max(100_000),
  limitations: z.array(z.string().min(1).max(32_768)).max(1024),
});
/** The host supplies exact immutable references and declares completeness across all three inventories. */
export type SourceUpdateInventory = z.infer<typeof inventorySchema>;
const currentReadSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('available'), projection: SourceProjectionSchema }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['missing', 'permission_denied', 'unsupported', 'corrupt']),
    /** selected_source requires a host-confirmed missing original path while its binding root remains readable. */
    missingScope: z.enum(['selected_source', 'binding']).optional() })]);
export type SourceCurrentReadResult = z.infer<typeof currentReadSchema>;
export interface SourceUpdatesPorts {
  store: Pick<SourceStore, 'read'>;
  /** With no replacement, revalidate the original fixed identity and ranges. Never refresh a Git branch implicitly. */
  readCurrent(snapshot: SourceSnapshot, replacementSelection?: SourceSelection, signal?: AbortSignal): SourceCurrentReadResult;
  now(): string;
  readInventory(): SourceUpdateInventory;
}
type HistoricalSource = { status: 'available' } | { status: 'unavailable'; reason: Extract<SourceResolution, { status: 'unavailable' }>['reason'] };
type ReviewTarget = { targetKind: 'source'; sourceRef: SourceRef } | { targetKind: 'body'; bodyRef: KnowledgeBodyRef }
  | { targetKind: 'catalog'; catalogRef: CatalogRef } | { targetKind: 'projection'; projectionRef: SourceProjectionRef };
export interface SourceUpdateReport {
  current: SourceCurrentState;
  historicalSource: HistoricalSource;
  changes: { comparisonScope: 'current_binding' | 'fixed_git_objects' | 'explicit_selection'; contentChanged?: boolean;
    metadataChanged?: boolean; selectedBytesChanged?: boolean; projectionTextChanged?: boolean };
  inventoryCompleteness: SourceUpdateInventory['status']; impactCompleteness: SourceUpdateInventory['status']; impactLimitations: string[];
  affectedExactBodyRefs: KnowledgeBodyRef[]; catalogRefs: CatalogRef[]; projectionRefs: SourceProjectionRef[];
  reviewSuggestions: { reviewKind: 'verify_availability' | 'compare_evidence' | 'confirm_replacement' | 'refresh_git_selector'
    | 'review_body' | 'review_catalog' | 'review_projection' | 'complete_inventory'; target: ReviewTarget; reason: string }[];
}
export class SourceUpdatesError extends Error {
  constructor(readonly code: 'invalid_request' | 'invalid_clock', message: string) { super(message); this.name = 'SourceUpdatesError'; }
}
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
const sha = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
function uniqueSorted<T>(values: readonly T[]): T[] {
  return [...new Map(values.map(value => [canonicalJson(value), value])).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value);
}
function location(projection: SourceProjection) {
  return projection.sourceKind === 'agent_trace'
    ? { sourceKind: projection.sourceKind, sourceId: projection.identity.sourceId, traceKind: projection.identity.traceKind }
    : { sourceKind: projection.sourceKind, projectId: projection.identity.projectId, relativePath: projection.identity.relativePath };
}
function sameSelection(requested: SourceSelection, projection: SourceProjection): boolean {
  if (requested.sourceKind !== projection.sourceKind) return false;
  if (requested.sourceKind === 'agent_trace' && projection.sourceKind === 'agent_trace') {
    return requested.sourceId === projection.identity.sourceId && requested.traceKind === projection.identity.traceKind
      && same(normalizeRecordRanges(requested.recordRanges, Math.max(...requested.recordRanges.map(range => range.endRecord))), projection.selection.recordRanges);
  }
  if (requested.sourceKind !== 'agent_trace' && projection.sourceKind !== 'agent_trace') {
    return requested.projectId === projection.identity.projectId && requested.relativePath === projection.identity.relativePath
      && (requested.lineRanges === null || same(normalizeLineRanges(requested.lineRanges,
        Math.max(...requested.lineRanges.map(range => range.endLine))), projection.selection.lineRanges));
  }
  return false;
}
function metadata(projection: SourceProjection) {
  const origin = projection.sourceKind === 'agent_trace' ? projection.origin : undefined;
  return { identity: projection.identity, selection: projection.selection, material: projection.material, provenance: projection.provenance,
    ...(origin ? { origin: { threadId: origin.threadId, ...(origin.turnId === undefined ? {} : { turnId: origin.turnId }), title: origin.title } } : {}),
    limitations: projection.limitations, rawCoordinates: projection.rawUnits.map(unit => unit.coordinate),
    excerptMetadata: projection.excerpts.map(excerpt => ({ unitId: excerpt.unitId, coordinate: excerpt.coordinate, material: excerpt.material })) };
}
function currentComparison(snapshot: SourceSnapshot, observed: SourceProjection, replacement: SourceSelection | undefined,
  state: SourceCurrentState, changes: SourceUpdateReport['changes']): void {
  const original = sourceSnapshotProjection(snapshot);
  state.observedIdentity = SourceIdentitySchema.parse({ sourceKind: observed.sourceKind, ...observed.identity });
  state.observedContentVersion = observed.contentVersion;
  if (replacement ? !sameSelection(replacement, observed) : !same(original.identity, observed.identity)
    || original.sourceKind !== observed.sourceKind || !same(original.selection, observed.selection)) {
    state.state = 'unknown'; state.limitations.push('当前读取未匹配原始固定身份和选区或显式替代选择，无法确认来源变化。'); return;
  }
  if (original.sourceKind !== observed.sourceKind) {
    state.state = 'unknown'; state.limitations.push('显式候选采用不同的来源类型，当前比较不能建立同一来源关系。'); return;
  }
  changes.contentChanged = original.contentVersion !== observed.contentVersion;
  changes.metadataChanged = !same(metadata(original), metadata(observed));
  changes.projectionTextChanged = !same(original.excerpts.map(excerpt => ({ unitId: excerpt.unitId, text: excerpt.text })),
    observed.excerpts.map(excerpt => ({ unitId: excerpt.unitId, text: excerpt.text })));
  const comparableSelection = same(original.selection, observed.selection);
  if (comparableSelection) {
    changes.selectedBytesChanged = !same(original.rawUnits.map(unit => unit.text), observed.rawUnits.map(unit => unit.text));
    state.selectedBytesChanged = changes.selectedBytesChanged;
  }
  if (replacement && !same(location(original), location(observed))) {
    state.state = 'possible_move'; state.limitations.push('显式替代位置仅是待核对的移动候选；即使字节相同，也需要人工确认来源身份。'); return;
  }
  if (!comparableSelection) {
    state.state = 'unknown'; state.limitations.push('显式选择改变了原始选区，选中字节的变化尚不可直接比较。'); return;
  }
  if (!changes.contentChanged && (changes.selectedBytesChanged || changes.projectionTextChanged)) {
    state.state = 'unknown'; state.limitations.push('原始内容版本相同但选中字节或可读投影改变，需要核对读取与投影依据。'); return;
  }
  state.state = changes.contentChanged ? 'content_changed' : changes.metadataChanged ? 'provenance_only_changed' : 'unchanged';
  if (changes.contentChanged && !changes.selectedBytesChanged) state.limitations.push('完整来源内容版本已变化，当前精确选中字节保持相同；需核对变化是否影响既有知识的适用条件。');
}
function inventoryImpact(inventory: SourceUpdateInventory, sourceRef: SourceRef) {
  const affectedExactBodyRefs = uniqueSorted(inventory.bodies.filter(item => item.sourceRefs.some(ref => same(ref, sourceRef))).map(item => item.bodyRef));
  const catalogRefs = uniqueSorted(inventory.catalogs.filter(item => same(item.sourceRef, sourceRef)).map(item => item.catalogRef));
  const bodyKeys = new Set(affectedExactBodyRefs.map(ref => canonicalJson(ref))), catalogKeys = new Set(catalogRefs.map(ref => canonicalJson(ref)));
  const projectionRefs = uniqueSorted(inventory.projections.filter(item => item.sourceRefs.some(ref => same(ref, sourceRef))
    || bodyKeys.has(canonicalJson(item.projectionRef.bodyRef)) || item.catalogRefs.some(ref => catalogKeys.has(canonicalJson(ref)))).map(item => item.projectionRef));
  return { affectedExactBodyRefs, catalogRefs, projectionRefs };
}

/** Read-only currentness and exact-reference impact. No source, body, association, review or model writes. */
export class SourceUpdatesService {
  constructor(private readonly ports: SourceUpdatesPorts) {}
  check(input: SourceRef, options: { replacementSelection?: SourceSelection; signal?: AbortSignal } = {}): SourceUpdateReport {
    options.signal?.throwIfAborted();
    const request = SourceRefSchema.safeParse(input), selector = options.replacementSelection === undefined ? undefined : SourceSelectionSchema.safeParse(options.replacementSelection);
    if (!request.success || selector && !selector.success) throw new SourceUpdatesError('invalid_request', 'An exact source reference and valid explicit selector are required.');
    const sourceRef = request.data, replacement = selector?.data, checkedAt = this.ports.now();
    if (!SourceCurrentStateSchema.shape.checkedAt.safeParse(checkedAt).success) throw new SourceUpdatesError('invalid_clock', 'The host must provide an ISO current-check time.');
    let source: SourceResolution;
    try { source = SourceResolutionSchema.parse(this.ports.store.read(sourceRef.snapshotId, sourceRef.sourceVersion)); }
    catch { source = { status: 'unavailable', reason: 'corrupt', detail: 'Historical source could not be verified.' }; }
    if (source.status === 'available' && (source.snapshot.snapshotId !== sourceRef.snapshotId || source.snapshot.sourceVersion !== sourceRef.sourceVersion)) {
      source = { status: 'unavailable', reason: 'version_mismatch', detail: 'Historical source does not match its exact reference.' };
    }
    options.signal?.throwIfAborted();
    const historicalSource: HistoricalSource = source.status === 'available' ? { status: 'available' } : { status: 'unavailable', reason: source.reason };
    const changes: SourceUpdateReport['changes'] = { comparisonScope: replacement ? 'explicit_selection'
      : source.status === 'available' && source.snapshot.sourceKind === 'git_blob' ? 'fixed_git_objects' : 'current_binding' };
    const current: SourceCurrentState = { sourceRef, checkedAt, state: 'unavailable', limitations: [] };
    if (source.status !== 'available') {
      current.limitations.push(source.reason === 'deleted' ? '历史捕获已被显式删除，本次不读取上游来源，也不恢复原引用。' : '历史捕获当前不可核对，无法建立当前来源与该精确版本的变化关系。');
    } else {
      if (changes.comparisonScope === 'fixed_git_objects') current.limitations.push('本次仅核对捕获时固定的 Git 对象，不能据此判断分支或项目的最新状态；刷新需要显式新选择。');
      let reading: SourceCurrentReadResult;
      try { reading = currentReadSchema.parse(this.ports.readCurrent(source.snapshot, replacement, options.signal)); }
      catch { options.signal?.throwIfAborted(); reading = { status: 'unavailable', reason: 'corrupt' }; }
      options.signal?.throwIfAborted();
      if (reading.status === 'available') {
        const projection = SourceProjectionSchema.safeParse(reading.projection);
        if (!projection.success || projection.data.rawUnits.some(unit => sha(unit.text) !== unit.rawByteDigest)) {
          current.limitations.push('当前读取未通过来源结构或精确原始字节校验。');
        } else currentComparison(source.snapshot, projection.data, replacement, current, changes);
      } else if (reading.reason === 'missing' && reading.missingScope === 'selected_source' && source.snapshot.sourceKind === 'project_file' && !replacement) {
        current.state = 'deleted'; current.limitations.push('宿主确认绑定根可读且原始选定文件路径缺失；历史捕获仍可核对，本次不寻找或确认替代身份。');
      } else current.limitations.push('当前来源读取不可用；绑定根失联、权限或对象缺失不能证明原始文件已删除。');
    }
    let inventory: SourceUpdateInventory;
    try { inventory = inventorySchema.parse(this.ports.readInventory()); }
    catch { inventory = { status: 'unavailable', bodies: [], catalogs: [], projections: [], limitations: ['引用清单未能完整读取或校验，当前不能排除已有影响。'] }; }
    options.signal?.throwIfAborted();
    const impact = inventoryImpact(inventory, sourceRef), impactLimitations = [...inventory.limitations];
    const impactCompleteness = (source.status !== 'available' || current.state === 'unavailable') && inventory.status === 'complete' ? 'partial' : inventory.status;
    if (impactCompleteness !== 'complete') impactLimitations.push('仅返回当前可核对的已知引用；空列表不能解释为完整的零影响。');
    if (source.status !== 'available') impactLimitations.push('历史来源不可用，影响结果缺少可核对的来源基线。');
    else if (current.state === 'unavailable') impactLimitations.push('引用清单覆盖范围单独报告；当前上游来源不可核对，整体影响结论保留不完整标记。');
    const reviewSuggestions: SourceUpdateReport['reviewSuggestions'] = [];
    const sourceTarget: ReviewTarget = { targetKind: 'source', sourceRef };
    if (current.state === 'possible_move') reviewSuggestions.push({ reviewKind: 'confirm_replacement', target: sourceTarget, reason: '核对原位置与显式候选的身份、来源范围和证据，确认前保留独立引用。' });
    else if (['deleted', 'unavailable', 'unknown'].includes(current.state)) reviewSuggestions.push({ reviewKind: 'verify_availability', target: sourceTarget, reason: '先核对历史捕获、绑定根、原位置与当前读取范围，再判断是否需要独立的新来源。' });
    else if (current.state !== 'unchanged') reviewSuggestions.push({ reviewKind: 'compare_evidence', target: sourceTarget, reason: changes.selectedBytesChanged === false
      ? '核对来源内容或归因变化对既有知识适用条件的影响；当前已选原始字节相同。' : '逐段对照原始和当前证据、归因与适用条件，再决定是否形成待审新修订。' });
    if (changes.comparisonScope === 'fixed_git_objects') reviewSuggestions.push({ reviewKind: 'refresh_git_selector', target: sourceTarget, reason: '需要了解分支最新状态时，显式提供 revision 选择并重新核对固定对象。' });
    if (current.state !== 'unchanged') {
      for (const bodyRef of impact.affectedExactBodyRefs) reviewSuggestions.push({ reviewKind: 'review_body', target: { targetKind: 'body', bodyRef }, reason: '核对该精确正文版本引用的证据与适用条件；后续修改应形成独立待审修订。' });
      for (const catalogRef of impact.catalogRefs) reviewSuggestions.push({ reviewKind: 'review_catalog', target: { targetKind: 'catalog', catalogRef }, reason: '核对该精确实体目录版本的提及、归因和不确定性。' });
      for (const projectionRef of impact.projectionRefs) reviewSuggestions.push({ reviewKind: 'review_projection', target: { targetKind: 'projection', projectionRef }, reason: '核对该精确派生投影的正文、目录和证据关联；原关联及其复核状态继续保留。' });
    }
    if (inventory.status !== 'complete') reviewSuggestions.push({ reviewKind: 'complete_inventory', target: sourceTarget, reason: '补齐不可用或遗漏的正文、目录与派生投影清单，再判断完整影响范围。' });
    return { current: SourceCurrentStateSchema.parse(current), historicalSource, changes, inventoryCompleteness: inventory.status,
      impactCompleteness, impactLimitations, ...impact, reviewSuggestions };
  }
}
