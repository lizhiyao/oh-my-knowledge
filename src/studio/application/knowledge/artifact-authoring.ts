import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createLocalKnowledgeApplication } from '../../../observability/application.js';
import { CarrierLibrary } from '../../../knowledge-artifacts/authoring/library.js';
import { carrierMetadata, chooseCarrierDirectory, composeCarrierContent, renderCarrierKnowledge } from '../../../knowledge-artifacts/authoring/knowledge-content.js';
import type { CarrierDraft, CarrierKnowledgeRef } from '../../view-models/knowledge/artifact-authoring.js';

const text = z.string().trim().min(1);
const uuid = z.string().uuid();
const ref = z.strictObject({ knowledgeId: uuid, revisionId: uuid, generation: z.number().int().positive() });
const source = z.discriminatedUnion('sourceKind', [z.strictObject({ sourceKind: z.literal('new') }), z.strictObject({ sourceKind: z.literal('library'), artifactId: uuid }), z.strictObject({ sourceKind: z.literal('local'), path: text })]);
const kind = z.enum(['skill', 'prompt']);
const schema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list'), workspace: text }),
  z.strictObject({ operation: z.literal('show'), workspace: text, id: uuid, version: z.number().int().positive().optional() }),
  z.strictObject({ operation: z.literal('preview'), workspace: text, source, artifactKind: kind, name: text.max(120), ids: z.array(uuid).max(100) }),
  z.strictObject({ operation: z.literal('save'), workspace: text, artifactId: uuid, source, artifactKind: kind, name: text.max(120), directoryName: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), baselineRevisionId: uuid.nullable(), baselineHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), content: z.string().min(1).max(2 * 1024 * 1024).refine(value => !!value.trim()), selectedRefs: z.array(ref).max(100), tagSelections: z.array(z.strictObject({ knowledgeId: uuid, generation: z.number().int().nonnegative() })).max(1000) }),
]);
function unionRefs(previous: CarrierKnowledgeRef[], selected: CarrierKnowledgeRef[]) {
  return [...new Map([...previous, ...selected].map(item => [`${item.knowledgeId}/${item.revisionId}`, item])).values()];
}

/** Studio supplies explicit selections; artifact authoring owns rendering, versions and byte publication. */
export function executeArtifactAuthoring(input: unknown, lang: 'zh' | 'en', signal?: AbortSignal) {
  const request = schema.parse(input); signal?.throwIfAborted();
  const library = new CarrierLibrary(request.workspace);
  if (request.operation === 'list') return library.list();
  if (request.operation === 'show') return library.show(request.id, request.version);
  const app = createLocalKnowledgeApplication(request.workspace);
  const baseline = library.baseline(request.source, request.artifactKind);
  if (request.operation === 'preview') {
    const items = [...new Set(request.ids)].map(id => app.detail(id));
    if (items.some(item => item.maintenance?.choice !== 'retain')) throw new Error('carrier_knowledge_conflict');
    if (!items.length && request.source.sourceKind !== 'library') throw new Error('carrier_selection_required');
    const selectedRefs = items.map(({ revision, history }) => ({ knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, generation: history.generation }));
    const previousRefs = baseline.detail?.knowledgeRefs ?? [];
    const knowledgeRefs = unionRefs(previousRefs, selectedRefs);
    const allItems = knowledgeRefs.map(ref => app.detail(ref.knowledgeId, ref.revisionId));
    const tagSelections = [...new Map(allItems.map(item => [item.revision.knowledgeId, { knowledgeId: item.revision.knowledgeId, generation: item.tagging.generation }])).values()];
    const fresh = items.filter(item => !previousRefs.some(ref => ref.knowledgeId === item.revision.knowledgeId && ref.revisionId === item.revision.revisionId));
    const material = renderCarrierKnowledge(fresh.map(item => ({ ...item, sourceWarnings: item.sources.flatMap(source => source.status === 'available' ? source.window.limitations : [`${lang === 'zh' ? '来源不可用' : 'Source unavailable'}: ${source.reason}`]) })), lang);
    const artifactId = baseline.detail?.artifactId ?? randomUUID();
    const directoryName = baseline.detail?.directoryName ?? chooseCarrierDirectory(request.name, artifactId, request.artifactKind, baseline.content);
    const draft: CarrierDraft = { artifactId, directoryName, artifactKind: request.artifactKind, name: request.name, source: request.source, baselineRevisionId: baseline.detail?.revisionId ?? null, baselineHash: baseline.hash, baseContent: baseline.content, content: composeCarrierContent(request.name, directoryName, request.artifactKind, material, baseline.content, lang, carrierMetadata(allItems.map(item => ({ ...item, sourceWarnings: [] })), request.artifactKind)), knowledgeRefs, selectedRefs, tagSelections };
    return draft;
  }
  const validateSelection = () => { for (const ref of request.selectedRefs) {
    const current = app.detail(ref.knowledgeId);
    if (current.revision.revisionId !== ref.revisionId || current.history.generation !== ref.generation || current.maintenance?.choice !== 'retain') throw new Error('carrier_knowledge_conflict');
  } };
  const refs = unionRefs(baseline.detail?.knowledgeRefs ?? [], request.selectedRefs);
  if (new Set(request.tagSelections.map(ref => ref.knowledgeId)).size !== request.tagSelections.length
    || new Set(refs.map(ref => ref.knowledgeId)).size !== request.tagSelections.length
    || request.tagSelections.some(ref => !refs.some(item => item.knowledgeId === ref.knowledgeId))) throw new Error('carrier_tag_selection_invalid');
  const validateAll = () => {
    validateSelection();
    for (const ref of request.tagSelections) if (app.detail(ref.knowledgeId).tagging.generation !== ref.generation) throw new Error('carrier_conflict');
  };
  validateAll();
  if (!request.selectedRefs.length && request.source.sourceKind !== 'library') throw new Error('carrier_selection_required');
  return library.save({ ...request, baseContent: baseline.content, knowledgeRefs: refs }, signal, validateAll);
}
