import { z } from 'zod';
import type { KnowledgeGenerationModel, KnowledgeApplication } from './application.js';
import { KnowledgeBodyRefSchema } from '../contracts.js';
import { KnowledgeRetrievalRequestSchema, retrieveKnowledge, retrieveKnowledgeText } from './retrieval.js';
import { KnowledgeStorageStateError } from '../../evidence/storage/knowledge-workspace.js';
import { EntityAnalysisWriteCapacityError } from '../entities/contracts.js';

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
  'apply-associations': z.strictObject({ operation: z.literal('apply-associations'), id: text, revision: text, bodyDigest: KnowledgeBodyRefSchema.shape.bodyDigest, analysisId: uuid, entityRevision: uuid, generation: z.number().int().nonnegative(), draft: z.unknown(), reason: text }),
  capture: z.strictObject({ operation: z.literal('capture'), source: text, startRecord: z.number().int().nonnegative().optional(), endRecord: z.number().int().nonnegative().optional() }),
  generate: z.strictObject({ operation: z.literal('generate'), snapshot: text, executor: text, model: text, runId: uuid.optional() }),
  inspect: z.strictObject({ operation: z.literal('inspect'), id: uuid }),
  'continue-stage': z.strictObject({ operation: z.literal('continue-stage'), id: uuid, generation: z.number().int().positive(), executor: text, model: text }),
  'rebuild-associations': KnowledgeBodyRefSchema.extend({ operation: z.literal('rebuild-associations'), executor: text, model: text, runId: uuid.optional() }),
  retrieve: z.strictObject({ ...KnowledgeRetrievalRequestSchema.shape, operation: z.literal('retrieve'),
    format: z.enum(['json', 'text']).optional(),
    maxBytes: KnowledgeRetrievalRequestSchema.shape.maxBytes.unwrap().optional(),
    includeCandidates: KnowledgeRetrievalRequestSchema.shape.includeCandidates.unwrap().optional(),
  }).refine(value => !value.sourceVersion || !!value.snapshot, { path: ['sourceVersion'], message: 'sourceVersion requires snapshot.' }),
  resume: z.strictObject({ operation: z.literal('resume'), id: text }),
  source: z.strictObject({ operation: z.literal('source'), snapshot: text }),
  'delete-source': z.strictObject({ operation: z.literal('delete-source'), snapshot: text }),
  maintain: z.strictObject({ operation: z.literal('maintain'), id: text, revision: text, generation: z.number().int().positive(), choice: z.enum(['retain', 'discard']), reason: text }),
  revise: z.strictObject({ operation: z.literal('revise'), id: text, revision: text, generation: z.number().int().positive(), draft: z.unknown(), reason: text }),
};
export const KnowledgeOperationSchema = z.discriminatedUnion('operation', [
  knowledgeOperationSchemas.list, knowledgeOperationSchemas.tag, knowledgeOperationSchemas.runs, knowledgeOperationSchemas.quality,
  knowledgeOperationSchemas.show, knowledgeOperationSchemas.entities, knowledgeOperationSchemas['entity-catalog'],
  knowledgeOperationSchemas['entity-detail'], knowledgeOperationSchemas['correct-entities'], knowledgeOperationSchemas.inspect, knowledgeOperationSchemas['continue-stage'], knowledgeOperationSchemas['rebuild-associations'], knowledgeOperationSchemas.retrieve,
  knowledgeOperationSchemas['review-associations'], knowledgeOperationSchemas['apply-associations'], knowledgeOperationSchemas.capture, knowledgeOperationSchemas.generate, knowledgeOperationSchemas.resume,
  knowledgeOperationSchemas.source, knowledgeOperationSchemas['delete-source'], knowledgeOperationSchemas.maintain, knowledgeOperationSchemas.revise,
]);
export type KnowledgeOperation = z.infer<typeof KnowledgeOperationSchema>;
type Results = {
  'review-associations': ReturnType<KnowledgeApplication['reviewAssociations']>; 'apply-associations': ReturnType<KnowledgeApplication['applyAssociations']>;
  list: ReturnType<KnowledgeApplication['list']>; tag: ReturnType<KnowledgeApplication['tag']>;
  quality: ReturnType<KnowledgeApplication['quality']>; runs: ReturnType<KnowledgeApplication['runs']>; show: ReturnType<KnowledgeApplication['detail']>;
  entities: ReturnType<KnowledgeApplication['entities']>; 'entity-catalog': ReturnType<KnowledgeApplication['queryEntities']>;
  'entity-detail': ReturnType<KnowledgeApplication['entityDetail']>; 'correct-entities': ReturnType<KnowledgeApplication['correctEntities']>;
  inspect: ReturnType<KnowledgeApplication['inspect']>; retrieve: ReturnType<typeof retrieveKnowledge> | string; 'continue-stage': Awaited<ReturnType<KnowledgeApplication['continueStage']>>; 'rebuild-associations': Awaited<ReturnType<KnowledgeApplication['rebuildAssociations']>>; capture: ReturnType<KnowledgeApplication['capture']>;
  generate: Awaited<ReturnType<KnowledgeApplication['generate']>>; resume: ReturnType<KnowledgeApplication['resume']>;
  source: ReturnType<KnowledgeApplication['source']>; 'delete-source': { deleted: string };
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
        includeCandidates: request.includeCandidates, snapshot: request.snapshot, sourceVersion: request.sourceVersion, entityId: request.entityId });
      case 'inspect': return app.inspect(request.id);
      case 'continue-stage': { if (!model) throw new Error('Generation model adapter unavailable.'); return app.continueStage(request.id, request.generation, model(request.executor, request.model), signal); }
      case 'rebuild-associations': { if (!model) throw new Error('Generation model adapter unavailable.'); return app.rebuildAssociations({ knowledgeId: request.knowledgeId, revisionId: request.revisionId, bodyDigest: request.bodyDigest }, model(request.executor, request.model), request.runId, signal); }
      case 'review-associations': return app.reviewAssociations(request.id, request.revision, request.generation, request.choice, request.reason);
      case 'apply-associations': return app.applyAssociations(request.id, request.revision, request.bodyDigest, request.analysisId, request.entityRevision, request.generation, request.draft, request.reason);
      case 'capture': return app.capture({ path: request.source, startRecord: request.startRecord, endRecord: request.endRecord }, signal);
      case 'generate': {
        if (!model) throw new Error('Extraction model adapter unavailable.');
        return app.generate(request.snapshot, model(request.executor, request.model), request.runId, signal);
      }
      case 'resume': return app.resume(request.id, signal);
      case 'source': return app.source(request.snapshot);
      case 'delete-source': app.deleteSource(request.snapshot); return { deleted: request.snapshot };
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
  if (cause instanceof z.ZodError || cause instanceof Error && /evidence|citation/i.test(cause.message)) return 'knowledge_citations_invalid';
  const message = cause instanceof Error ? cause.message : '';
  return /conflict/i.test(message) ? 'knowledge_conflict'
    : message === 'Knowledge tags invalid.' ? 'knowledge_tags_invalid'
    : /capacity|exceeds/i.test(message) ? 'knowledge_capacity_exceeded' : 'knowledge_request_failed';
}
