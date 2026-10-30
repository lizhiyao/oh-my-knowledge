import { z } from 'zod';
import type { KnowledgeGenerationModel, KnowledgeApplication } from './application.js';
import { KnowledgeBodyRefSchema } from '../contracts.js';
import { KnowledgeRetrievalRequestSchema, retrieveKnowledge, retrieveKnowledgeText } from './retrieval.js';
import { KnowledgeStorageStateError } from '../../evidence/storage/knowledge-workspace.js';
import { EntityAnalysisWriteCapacityError } from '../entities/contracts.js';
import { SourceDigestSchema, SourceRefSchema, SourceSelectionSchema, ResolvedSourceSelectionSchema } from '../sources.js';
import { SourceCaptureError } from './source-capture.js';
import { SourceStoreError } from '../adapters/source-store.js';
import { SourceLedgerRefSchema, SourceCoverageDecisionRefSchema, SourceCoverageWriteSchema } from '../source-review.js';

const text = z.string().trim().min(1);
const uuid = z.string().uuid();
/** Host-independent use-case inputs. Hosts own workspace selection and presentation. */
export const knowledgeOperationSchemas = {
  list: z.strictObject({ operation: z.literal('list') }),
  tag: z.strictObject({ operation: z.literal('tag'), id: text, generation: z.number().int().nonnegative(), tags: z.array(z.string()).max(32) }),
  runs: z.strictObject({ operation: z.literal('runs') }),
  quality: z.strictObject({ operation: z.literal('quality') }),
  show: z.strictObject({ operation: z.literal('show'), id: text, revision: text.optional() }),
  entities: z.strictObject({ operation: z.literal('entities'), analysisId: uuid, revision: uuid.optional() }),
  'entity-catalog': z.strictObject({ operation: z.literal('entity-catalog'), query: text.max(512).optional(), identityStatus: z.enum(['all', 'proposed', 'unresolved']).optional(), sourceStatus: z.enum(['all', 'available', 'unavailable']).optional(), threadId: text.optional(), analysisId: uuid.optional(), page: z.number().int().min(1).max(100_000).optional(), pageSize: z.number().int().min(1).max(100).optional() }),
  'entity-detail': z.strictObject({ operation: z.literal('entity-detail'), analysisId: uuid, entityId: uuid, revision: uuid.optional() }),
  'correct-entities': z.strictObject({ operation: z.literal('correct-entities'), analysisId: uuid, revision: uuid, generation: z.number().int().positive(), draft: z.unknown(), reason: text }),
  'review-associations': z.strictObject({ operation: z.literal('review-associations'), id: text, revision: text, generation: z.number().int().positive(), choice: z.enum(['accept','reject']), reason: text }),
  'apply-associations': z.strictObject({ operation: z.literal('apply-associations'), id: text, revision: text, bodyDigest: KnowledgeBodyRefSchema.shape.bodyDigest, generation: z.number().int().nonnegative(), draft: z.unknown(), reason: text }),
  'preview-sources': z.strictObject({ operation: z.literal('preview-sources'), selections: z.array(SourceSelectionSchema).min(1).max(256), afterDeletion: z.literal('new_snapshot').optional() }),
  capture: z.strictObject({ operation: z.literal('capture'), selections: z.array(ResolvedSourceSelectionSchema).min(1).max(256), previewDigest: SourceDigestSchema, afterDeletion: z.literal('new_snapshot').optional() }),
  'prepare-generation': z.strictObject({ operation: z.literal('prepare-generation'), sources: z.array(SourceRefSchema).min(1).max(256), executor: text, model: text, runId: uuid.optional(), sourceCoverageDecisionRef: SourceCoverageDecisionRefSchema.optional() }),
  'prepare-source-review': z.strictObject({ operation: z.literal('prepare-source-review'), sources: z.array(SourceRefSchema).min(1).max(256),
    bodyRefs: z.array(KnowledgeBodyRefSchema).max(256), ledgerRef: SourceLedgerRefSchema.optional(), executor: text, model: text, runId: uuid.optional() }),
  'source-ledger': z.strictObject({ operation: z.literal('source-ledger'), id: uuid, revision: uuid.optional() }),
  'source-coverage-status': z.strictObject({ operation: z.literal('source-coverage-status'), id: uuid, revision: uuid.optional() }),
  'review-source-coverage': z.strictObject({ operation: z.literal('review-source-coverage'),
    command: z.discriminatedUnion('commandKind', [SourceCoverageWriteSchema.options[1], SourceCoverageWriteSchema.options[2]]) }),
  generate: z.strictObject({ operation: z.literal('generate'), sources: z.array(SourceRefSchema).min(1).max(256), executor: text, model: text, runId: uuid.optional(), confirmedRequestDigest: SourceDigestSchema }),
  inspect: z.strictObject({ operation: z.literal('inspect'), id: uuid }),
  'continue-stage': z.strictObject({ operation: z.literal('continue-stage'), id: uuid, generation: z.number().int().positive(), executor: text, model: text, confirmedRequestDigest: SourceDigestSchema }),
  'prepare-rebuild-associations': KnowledgeBodyRefSchema.extend({ operation: z.literal('prepare-rebuild-associations'), executor: text, model: text, runId: uuid.optional(), sourceCoverageDecisionRef: SourceCoverageDecisionRefSchema }),
  'rebuild-associations': KnowledgeBodyRefSchema.extend({ operation: z.literal('rebuild-associations'), executor: text, model: text, runId: uuid.optional(), confirmedRequestDigest: SourceDigestSchema, sourceCoverageDecisionRef: SourceCoverageDecisionRefSchema }),
  retrieve: z.strictObject({ ...KnowledgeRetrievalRequestSchema.shape, operation: z.literal('retrieve'),
    format: z.enum(['json', 'text']).optional(),
    maxBytes: KnowledgeRetrievalRequestSchema.shape.maxBytes.unwrap().optional(),
    includeCandidates: KnowledgeRetrievalRequestSchema.shape.includeCandidates.unwrap().optional(),
  }).refine(value => [value.analysisId, value.entityRevisionId, value.entityId].filter(value => value !== undefined).length % 3 === 0,
    { message: 'Entity scope requires analysisId, entityRevisionId and entityId.' }).refine(value => !!value.sourceVersion === !!value.snapshot, { path: ['sourceVersion'], message: 'Source scope requires both snapshot and sourceVersion.' }),
  resume: z.strictObject({ operation: z.literal('resume'), id: text }),
  source: z.strictObject({ operation: z.literal('source'), source: SourceRefSchema }),
  'source-updates': z.strictObject({ operation: z.literal('source-updates'), source: SourceRefSchema, replacementSelection: SourceSelectionSchema.optional() }),
  'delete-source': z.strictObject({ operation: z.literal('delete-source'), source: SourceRefSchema }),
  maintain: z.strictObject({ operation: z.literal('maintain'), id: text, revision: text, generation: z.number().int().positive(), choice: z.enum(['retain', 'discard']), reason: text }),
  revise: z.strictObject({ operation: z.literal('revise'), id: text, revision: text, generation: z.number().int().positive(), draft: z.unknown(), reason: text }),
};
export const KnowledgeOperationSchema = z.discriminatedUnion('operation', [
  knowledgeOperationSchemas.list, knowledgeOperationSchemas.tag, knowledgeOperationSchemas.runs, knowledgeOperationSchemas.quality,
  knowledgeOperationSchemas['prepare-source-review'], knowledgeOperationSchemas['source-ledger'],
  knowledgeOperationSchemas['source-coverage-status'], knowledgeOperationSchemas['review-source-coverage'],
  knowledgeOperationSchemas.show, knowledgeOperationSchemas.entities, knowledgeOperationSchemas['entity-catalog'],
  knowledgeOperationSchemas['entity-detail'], knowledgeOperationSchemas['correct-entities'], knowledgeOperationSchemas.inspect, knowledgeOperationSchemas['continue-stage'], knowledgeOperationSchemas['prepare-rebuild-associations'], knowledgeOperationSchemas['rebuild-associations'], knowledgeOperationSchemas.retrieve,
  knowledgeOperationSchemas['review-associations'], knowledgeOperationSchemas['apply-associations'], knowledgeOperationSchemas['preview-sources'], knowledgeOperationSchemas.capture, knowledgeOperationSchemas['prepare-generation'], knowledgeOperationSchemas.generate, knowledgeOperationSchemas.resume,
  knowledgeOperationSchemas.source, knowledgeOperationSchemas['source-updates'], knowledgeOperationSchemas['delete-source'], knowledgeOperationSchemas.maintain, knowledgeOperationSchemas.revise,
]);
export type KnowledgeOperation = z.infer<typeof KnowledgeOperationSchema>;
type Results = {
  'prepare-source-review': ReturnType<KnowledgeApplication['prepareSourceReview']>;
  'source-ledger': ReturnType<KnowledgeApplication['sourceLedger']>;
  'source-coverage-status': ReturnType<KnowledgeApplication['sourceCoverageStatus']>;
  'review-source-coverage': ReturnType<KnowledgeApplication['reviewSourceCoverage']>;
  'review-associations': ReturnType<KnowledgeApplication['reviewAssociations']>; 'apply-associations': ReturnType<KnowledgeApplication['applyAssociations']>;
  list: ReturnType<KnowledgeApplication['list']>; tag: ReturnType<KnowledgeApplication['tag']>;
  quality: ReturnType<KnowledgeApplication['quality']>; runs: ReturnType<KnowledgeApplication['runs']>; show: ReturnType<KnowledgeApplication['detail']>;
  entities: ReturnType<KnowledgeApplication['entities']>; 'entity-catalog': ReturnType<KnowledgeApplication['queryEntities']>;
  'entity-detail': ReturnType<KnowledgeApplication['entityDetail']>; 'correct-entities': ReturnType<KnowledgeApplication['correctEntities']>;
  inspect: ReturnType<KnowledgeApplication['inspect']>; retrieve: ReturnType<typeof retrieveKnowledge> | string; 'continue-stage': Awaited<ReturnType<KnowledgeApplication['continueStage']>>; 'rebuild-associations': Awaited<ReturnType<KnowledgeApplication['rebuildAssociations']>>;
  'preview-sources': ReturnType<KnowledgeApplication['previewSources']>; capture: ReturnType<KnowledgeApplication['captureSources']>;
  'prepare-generation': Awaited<ReturnType<KnowledgeApplication['prepareGeneration']>>; 'prepare-rebuild-associations': Awaited<ReturnType<KnowledgeApplication['prepareAssociationRebuild']>>;
  generate: Awaited<ReturnType<KnowledgeApplication['generate']>>; resume: ReturnType<KnowledgeApplication['resume']>;
  source: ReturnType<KnowledgeApplication['source']>; 'delete-source': { deleted: z.infer<typeof SourceRefSchema> };
  'source-updates': ReturnType<KnowledgeApplication['sourceUpdates']>;
  maintain: ReturnType<KnowledgeApplication['maintain']>; revise: ReturnType<KnowledgeApplication['revise']>;
};
/** One dispatch path for CLI and Studio; models remain an injected host adapter. */
export async function executeKnowledgeOperation<C extends KnowledgeOperation>(app: KnowledgeApplication, request: C,
  signal?: AbortSignal, model?: (executor: string, model: string) => KnowledgeGenerationModel): Promise<Results[C['operation']]> {
  signal?.throwIfAborted();
  const execute = () => {
    switch (request.operation) {
      case 'list': return app.list();
      case 'tag': return app.tag(request.id, request.generation, request.tags);
      case 'runs': return app.runs();
      case 'quality': return app.quality();
      case 'show': return app.detail(request.id, request.revision);
      case 'entities': return app.entities(request.analysisId, request.revision);
      case 'entity-catalog': return app.queryEntities({ query: request.query, identityStatus: request.identityStatus, sourceStatus: request.sourceStatus, threadId: request.threadId, analysisId: request.analysisId, page: request.page, pageSize: request.pageSize });
      case 'entity-detail': return app.entityDetail(request.analysisId, request.entityId, request.revision);
      case 'correct-entities': return app.correctEntities(request.analysisId, request.revision, request.generation, request.draft, request.reason);
      case 'retrieve': return (request.format === 'text' ? retrieveKnowledgeText : retrieveKnowledge)(app, { query: request.query, maxBytes: request.maxBytes,
        includeCandidates: request.includeCandidates, snapshot: request.snapshot, sourceVersion: request.sourceVersion, analysisId: request.analysisId, entityRevisionId: request.entityRevisionId, entityId: request.entityId });
      case 'inspect': return app.inspect(request.id);
      case 'source-ledger': return app.sourceLedger(request.id, request.revision);
      case 'source-coverage-status': return app.sourceCoverageStatus(request.id, request.revision);
      case 'review-source-coverage': return app.reviewSourceCoverage(request.command);
      case 'prepare-source-review': { if (!model) throw new Error('Generation model adapter unavailable.');
        return app.prepareSourceReview(request.sources, request.bodyRefs, model(request.executor, request.model), request.ledgerRef, request.runId, signal); }
      case 'continue-stage': { if (!model) throw new Error('Generation model adapter unavailable.'); return app.continueStage(request.id, request.generation, model(request.executor, request.model), signal, { confirmedRequestDigest: request.confirmedRequestDigest }); }
      case 'prepare-rebuild-associations': { if (!model) throw new Error('Generation model adapter unavailable.'); return app.prepareAssociationRebuild({ knowledgeId: request.knowledgeId, revisionId: request.revisionId, bodyDigest: request.bodyDigest }, model(request.executor, request.model), request.sourceCoverageDecisionRef, request.runId, signal); }
      case 'rebuild-associations': { if (!model) throw new Error('Generation model adapter unavailable.'); return app.rebuildAssociations({ knowledgeId: request.knowledgeId, revisionId: request.revisionId, bodyDigest: request.bodyDigest }, model(request.executor, request.model), request.sourceCoverageDecisionRef, request.runId, signal, { confirmedRequestDigest: request.confirmedRequestDigest }); }
      case 'review-associations': return app.reviewAssociations(request.id, request.revision, request.generation, request.choice, request.reason);
      case 'apply-associations': return app.applyAssociations(request.id, request.revision, request.bodyDigest, request.generation, request.draft, request.reason);
      case 'preview-sources': return app.previewSources(request.selections, { afterDeletion: request.afterDeletion, signal });
      case 'capture': { const preview = app.previewResolvedSources(request.selections, { afterDeletion: request.afterDeletion, expectedDigest: request.previewDigest, signal });
        return app.captureSources({ previewId: preview.previewId, previewDigest: preview.previewDigest }, signal); }
      case 'prepare-generation': { if (!model) throw new Error('Generation model adapter unavailable.'); return app.prepareGeneration(request.sources, model(request.executor, request.model), request.runId, signal, request.sourceCoverageDecisionRef); }
      case 'generate': {
        if (!model) throw new Error('Extraction model adapter unavailable.');
        return app.generate(request.sources, model(request.executor, request.model), request.runId, signal, { confirmedRequestDigest: request.confirmedRequestDigest });
      }
      case 'resume': return app.resume(request.id, signal);
      case 'source': return app.source(request.source);
      case 'source-updates': return app.sourceUpdates(request.source, request.replacementSelection, signal);
      case 'delete-source': app.deleteSource(request.source); return { deleted: request.source };
      case 'maintain': return app.maintain(request.id, request.revision, request.choice, request.reason, request.generation);
      case 'revise': return app.revise(request.id, request.revision, request.generation, request.draft, request.reason);
      default: { const unreachable: never = request; throw new Error(`Unknown knowledge operation: ${String(unreachable)}`); }
    }
  };
  // The exhaustive switch keeps input/result correlation at the shared dispatch boundary.
  return await execute() as Results[C['operation']];
}

export function knowledgeFailureCode(cause: unknown): 'knowledge_storage_unsupported' | 'knowledge_workspace_busy' | 'knowledge_conflict' | 'knowledge_tags_invalid' | 'knowledge_capacity_exceeded' | 'knowledge_citations_invalid' | 'knowledge_request_failed' {
  if (cause instanceof KnowledgeStorageStateError) return cause.stateCode;
  if (cause instanceof EntityAnalysisWriteCapacityError) return 'knowledge_capacity_exceeded';
  if (cause instanceof SourceCaptureError) return cause.code === 'capacity_exceeded' ? 'knowledge_capacity_exceeded'
    : ['preview_mismatch', 'scope_changed', 'source_changed'].includes(cause.code) ? 'knowledge_conflict' : 'knowledge_request_failed';
  if (cause instanceof SourceStoreError) return cause.code === 'capacity_exceeded' ? 'knowledge_capacity_exceeded' : cause.code === 'busy' ? 'knowledge_workspace_busy' : cause.code === 'version_mismatch' ? 'knowledge_conflict' : 'knowledge_request_failed';
  if (cause instanceof z.ZodError || cause instanceof Error && /evidence|citation/i.test(cause.message)) return 'knowledge_citations_invalid';
  const message = cause instanceof Error ? cause.message : '';
  return /conflict/i.test(message) ? 'knowledge_conflict'
    : message === 'Knowledge tags invalid.' ? 'knowledge_tags_invalid'
    : /capacity|exceeds/i.test(message) ? 'knowledge_capacity_exceeded' : 'knowledge_request_failed';
}
