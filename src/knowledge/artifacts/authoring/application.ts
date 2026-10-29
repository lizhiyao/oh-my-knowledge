import { z } from 'zod';
import type { CarrierLibrary } from './carrier-library.js';
import { carrierMetadata, chooseCarrierDirectory, composeCarrierContent, renderCarrierKnowledge } from './knowledge-content.js';
import { reviewCarrierKnowledge } from './knowledge-review.js';
import type { KnowledgeRevision } from '../../contracts.js';
import type { CarrierDetail, ReviewedCarrierDraft } from './carrier-contracts.js';

const text = z.string().trim().min(1);
const uuid = z.string().uuid();
const ref = z.strictObject({ knowledgeId: uuid, revisionId: uuid, generation: z.number().int().positive() });
const source = z.discriminatedUnion('sourceKind', [z.strictObject({ sourceKind: z.literal('new') }), z.strictObject({ sourceKind: z.literal('library'), artifactId: uuid }), z.strictObject({ sourceKind: z.literal('local'), path: text })]);
const kind = z.enum(['skill', 'prompt']);
const schema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('show'), id: uuid, version: z.number().int().positive().optional() }),
  z.strictObject({ operation: z.literal('preview'), source, artifactKind: kind, name: text.max(120), ids: z.array(uuid).max(100) }),
  z.strictObject({ operation: z.literal('save'), artifactId: uuid, source, artifactKind: kind, name: text.max(120), directoryName: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), baselineRevisionId: uuid.nullable(), baselineHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), content: z.string().min(1).max(2 * 1024 * 1024).refine(value => !!value.trim()), selectedRefs: z.array(ref).max(100), tagSelections: z.array(z.strictObject({ knowledgeId: uuid, generation: z.number().int().nonnegative() })).max(1000) }),
]);

/** Only knowledge fields needed to select, render and review a carrier. */
export interface CarrierAuthoringKnowledge {
  revision: KnowledgeRevision;
  history: { generation: number };
  tagging: { generation: number; tags: string[] };
  maintenance: { choice: 'retain' | 'discard' } | null;
  sources: ({ status: 'available'; window: { limitations: string[] } } | { status: 'unavailable'; reason: string })[];
}
export interface CarrierAuthoringPorts {
  knowledge: { detail(id: string, revisionId?: string): CarrierAuthoringKnowledge };
  library: Pick<CarrierLibrary, 'list' | 'show' | 'baseline' | 'save'>;
  id(): string;
  now(): string;
}

/** Hosts validate the complete command before constructing effectful local ports. */
export function parseCarrierAuthoringRequest(input: unknown) { return schema.parse(input); }

/** Shared carrier use cases own selection, exact revisions, review and publication checks. */
export function executeCarrierAuthoring(request: ReturnType<typeof parseCarrierAuthoringRequest>, ports: CarrierAuthoringPorts, lang: 'zh' | 'en', signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { library, knowledge: app } = ports;
  const render = (item: ReturnType<typeof app.detail>, language: 'zh' | 'en') => ({ ...item, sourceWarnings: item.sources.flatMap(source => source.status === 'available' ? source.window.limitations : [`${language === 'zh' ? '来源不可用' : 'Source unavailable'}: ${source.reason}`]) });
  const reviewed = (detail: CarrierDetail, includeContent = true) => ({ ...detail, knowledgeReview: reviewCarrierKnowledge(detail.knowledgeRefs, (id, revisionId) => {
    const item = app.detail(id, revisionId);
    return { ...render(item, lang), choice: item.maintenance?.choice ?? null, sourceAvailable: item.sources.every(source => source.status === 'available') };
  }, lang, ports.now(), includeContent) });
  if (request.operation === 'list') return library.list().map(row => {
    const { referenceCount, needsReviewCount, unavailableCount } = reviewed(library.show(row.artifactId), false).knowledgeReview;
    return { ...row, knowledgeReview: { referenceCount, needsReviewCount, unavailableCount } };
  });
  if (request.operation === 'show') return reviewed(library.show(request.id, request.version));
  const baseline = library.baseline(request.source, request.artifactKind);
  if (request.operation === 'preview') {
    const items = [...new Set(request.ids)].map(id => app.detail(id));
    if (items.some(item => item.maintenance?.choice !== 'retain')) throw new Error('carrier_knowledge_conflict');
    if (!items.length && request.source.sourceKind !== 'library') throw new Error('carrier_selection_required');
    const selectedRefs = items.map(({ revision, history }) => ({ knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, generation: history.generation }));
    const previousRefs = baseline.detail?.knowledgeRefs ?? [];
    const knowledgeRefs = selectedRefs;
    const tagSelections = items.map(item => ({ knowledgeId: item.revision.knowledgeId, generation: item.tagging.generation }));
    const material = renderCarrierKnowledge(items.map(item => render(item, lang)), lang);
    const previousMaterials = baseline.detail ? previousRefs.map(ref => {
      const item = app.detail(ref.knowledgeId, ref.revisionId);
      return (['zh', 'en'] as const).map(language => renderCarrierKnowledge([render(item, language)], language));
    }) : undefined;
    const artifactId = baseline.detail?.artifactId ?? ports.id();
    const directoryName = baseline.detail?.directoryName ?? chooseCarrierDirectory(request.name, artifactId, request.artifactKind, baseline.content);
    const draft: ReviewedCarrierDraft = { artifactId, directoryName, artifactKind: request.artifactKind, name: request.name, source: request.source, baselineRevisionId: baseline.detail?.revisionId ?? null, baselineHash: baseline.hash, baseContent: baseline.content, content: composeCarrierContent(request.name, directoryName, request.artifactKind, material, baseline.content, lang, carrierMetadata(items.map(item => ({ ...item, sourceWarnings: [] })), request.artifactKind), previousMaterials), knowledgeRefs, selectedRefs, tagSelections, selectionChanges: [...new Set([...previousRefs.map(ref => ref.knowledgeId), ...selectedRefs.map(ref => ref.knowledgeId)])].map(knowledgeId => {
      const previous = previousRefs.filter(ref => ref.knowledgeId === knowledgeId), selected = selectedRefs.find(ref => ref.knowledgeId === knowledgeId);
      return { knowledgeId, title: items.find(item => item.revision.knowledgeId === knowledgeId)?.revision.title ?? app.detail(knowledgeId, previous.at(-1)!.revisionId).revision.title, previousRevisionIds: previous.map(ref => ref.revisionId), selectedRevisionId: selected?.revisionId ?? null,
        changeKind: !selected ? 'removed' : !previous.length ? 'added' : previous.length === 1 && previous[0].revisionId === selected.revisionId ? 'kept' : 'replaced' };
    }) };
    return draft;
  }
  const validateSelection = () => { for (const ref of request.selectedRefs) {
    const current = app.detail(ref.knowledgeId);
    if (current.revision.revisionId !== ref.revisionId || current.history.generation !== ref.generation || current.maintenance?.choice !== 'retain') throw new Error('carrier_knowledge_conflict');
  } };
  const refs = request.selectedRefs;
  if (new Set(refs.map(ref => ref.knowledgeId)).size !== refs.length) throw new Error('carrier_knowledge_conflict');
  if (new Set(request.tagSelections.map(ref => ref.knowledgeId)).size !== request.tagSelections.length
    || new Set(refs.map(ref => ref.knowledgeId)).size !== request.tagSelections.length
    || request.tagSelections.some(ref => !refs.some(item => item.knowledgeId === ref.knowledgeId))) throw new Error('carrier_tag_selection_invalid');
  const validateAll = () => {
    validateSelection();
    for (const ref of request.tagSelections) if (app.detail(ref.knowledgeId).tagging.generation !== ref.generation) throw new Error('carrier_conflict');
  };
  validateAll();
  if (!request.selectedRefs.length && request.source.sourceKind !== 'library') throw new Error('carrier_selection_required');
  return reviewed(library.save({ ...request, baseContent: baseline.content, knowledgeRefs: refs }, signal, validateAll));
}
