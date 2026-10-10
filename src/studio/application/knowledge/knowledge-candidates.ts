import {
  type ConversationCatalog,
  createLocalKnowledgeApplication,
  configuredExtractionModel,
  extractionRunSummary,
  type KnowledgeApplication,
} from '../../../observability/application.js';
import { conversationExtractionSource } from '../conversations/conversation-extraction.js';
import { z } from 'zod';
import type { KnowledgeCandidateDetail, KnowledgeEntityAnalysisDetail } from '../../view-models/knowledge/knowledge-candidates.js';

const text = z.string().trim().min(1);
const common = { workspace: text };
function entityDetail(detail: ReturnType<KnowledgeApplication['entities']>): KnowledgeEntityAnalysisDetail {
  return { ...detail, source: detail.source.status === 'available'
    ? { status: 'available', excerpts: detail.source.window.excerpts, limitations: detail.source.window.limitations } : detail.source };
}
function candidateDetail(detail: ReturnType<KnowledgeApplication['detail']>): KnowledgeCandidateDetail {
  const { entityAnalysis, ...rest } = detail;
  return { ...rest, ...(entityAnalysis ? { entityAnalysis: entityAnalysis.status === 'available'
    ? { status: 'available' as const, ...entityDetail(entityAnalysis) } : entityAnalysis } : {}) };
}
const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ workspace: z.string().optional(), operation: z.literal('conversations') }),
  z.strictObject({ workspace: z.string().optional(), operation: z.literal('conversation'), threadId: text }),
  z.strictObject({ workspace: z.string().optional(), operation: z.literal('preview-conversation'), threadId: text, turnId: text.optional() }),
  z.strictObject({ ...common, operation: z.literal('capture-conversation'), threadId: text, turnId: text.optional(), sourceVersion: text, recordIndexes: z.array(z.number().int().nonnegative()).min(1).max(1000) }),
  z.strictObject({ ...common, operation: z.literal('queue'), threadId: text.optional(), projectId: text.optional() }),
  z.strictObject({ ...common, operation: z.literal('list') }),
  z.strictObject({ ...common, operation: z.literal('tag'), id: text, generation: z.number().int().nonnegative(), tags: z.array(z.string()).max(32) }),
  z.strictObject({ ...common, operation: z.literal('runs') }),
  z.strictObject({ ...common, operation: z.literal('show'), id: text, revision: text.optional() }),
  z.strictObject({ ...common, operation: z.literal('entities'), analysisId: z.string().uuid(), revision: z.string().uuid().optional() }),
  z.strictObject({ ...common, operation: z.literal('entity-catalog'), query: text.max(512).optional(), identityStatus: z.enum(['all', 'proposed', 'unresolved']).optional(), sourceStatus: z.enum(['all', 'available', 'unavailable']).optional(), threadId: text.optional(), analysisId: z.string().uuid().optional(), page: z.number().int().min(1).max(100_000).optional(), pageSize: z.number().int().min(1).max(100).optional() }),
  z.strictObject({ ...common, operation: z.literal('entity-detail'), analysisId: z.string().uuid(), entityId: z.string().uuid(), revision: z.string().uuid().optional() }),
  z.strictObject({ ...common, operation: z.literal('correct-entities'), analysisId: z.string().uuid(), revision: z.string().uuid(), generation: z.number().int().positive(), draft: z.unknown(), reason: text }),
  z.strictObject({ ...common, operation: z.literal('apply-entities'), id: text, revision: text, generation: z.number().int().positive(), analysisId: z.string().uuid(), entityRevision: z.string().uuid(), draft: z.unknown(), reason: text, identityUncertainties: z.array(text.max(4096)).max(64).optional() }),
  z.strictObject({ ...common, operation: z.literal('capture'), source: text, startRecord: z.number().int().nonnegative().optional(), endRecord: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...common, operation: z.literal('generate'), snapshot: text, executor: text, model: text, runId: z.string().uuid() }),
  z.strictObject({ ...common, operation: z.literal('resume'), id: text }),
  z.strictObject({ ...common, operation: z.literal('delete-source'), snapshot: text }),
  z.strictObject({ ...common, operation: z.literal('maintain'), id: text, revision: text, generation: z.number().int().positive(), choice: z.enum(['retain', 'discard']), reason: text }),
  z.strictObject({ ...common, operation: z.literal('revise'), id: text, revision: text, generation: z.number().int().positive(), draft: z.unknown(), reason: text }),
]);

export async function executeKnowledgeCandidateAction(input: unknown, signal?: AbortSignal,
  create: (root: string) => KnowledgeApplication = createLocalKnowledgeApplication, catalog?: ConversationCatalog): Promise<unknown> {
  const request = requestSchema.parse(input);
  if (request.operation === 'conversations') {
    if (!catalog) throw new Error('Conversation catalog unavailable.');
    return (await catalog.listConversations()).conversations.map(({ threadId, title, cwd }) => ({ threadId, title, cwd }));
  }
  if (request.operation === 'conversation') {
    if (!catalog) throw new Error('Conversation catalog unavailable.');
    const conversation = await catalog.getConversation(request.threadId);
    if (!conversation) throw new Error('Conversation unavailable.');
    return { threadId: conversation.threadId, title: conversation.title, cwd: conversation.cwd, tasks: conversation.tasks.map(({ turnId, sourceTurnId, title }) => ({ turnId: sourceTurnId ?? turnId, title })) };
  }
  if (request.operation === 'preview-conversation' || request.operation === 'capture-conversation') {
    if (!catalog) throw new Error('Conversation catalog unavailable.');
    const { window, messages } = await conversationExtractionSource(catalog, request.threadId, request.turnId, signal);
    if (request.operation === 'preview-conversation') return { origin: window.origin, sourceVersion: window.sourceVersion, messages };
    if (request.sourceVersion !== window.sourceVersion) throw new Error('Source conflict. Preview again.');
    const selected = new Set(request.recordIndexes);
    if ([...selected].some(index => !messages.some(message => message.recordIndex === index))) throw new Error('Invalid message selection.');
    return create(request.workspace).capture({ path: window.sourcePath, origin: window.origin, records: window.records.filter(record => selected.has(record.recordIndex)) }, signal);
  }
  const app = create(request.workspace);
  switch (request.operation) {
    case 'queue': {
      if (request.threadId && request.projectId) throw new Error('Select one knowledge scope.');
      const projectThreads = request.projectId && catalog ? new Set((await catalog.listConversations()).conversations
        .filter(item => (item.project?.projectId ?? item.cwd) === request.projectId).map(item => item.threadId)) : undefined;
      if (request.projectId && !catalog) throw new Error('Conversation catalog unavailable.');
      const runs = app.runs().filter(run => request.threadId ? run.origin?.threadId === request.threadId
        : projectThreads ? Boolean(run.origin && projectThreads.has(run.origin.threadId)) : true);
      const ids = new Set(runs.flatMap(run => run.committed.map(ref => ref.knowledgeId)));
      return { rows: app.list().filter(row => ids.has(row.knowledgeId)), runs: runs.map(extractionRunSummary) };
    }
    case 'list': return app.list();
    case 'tag': return app.tag(request.id, request.generation, request.tags);
    case 'runs': return app.runs().sort((a, b) => (Date.parse(b.startedAt) - Date.parse(a.startedAt)) || a.runId.localeCompare(b.runId)).map(extractionRunSummary);
    case 'show': return { ...candidateDetail(app.detail(request.id, request.revision)), origin: app.runs().find(run => run.committed.some(ref => ref.knowledgeId === request.id))?.origin };
    case 'entities': return entityDetail(app.entities(request.analysisId, request.revision));
    case 'entity-catalog': return app.queryEntities({ query: request.query, identityStatus: request.identityStatus, sourceStatus: request.sourceStatus,
      threadId: request.threadId, analysisId: request.analysisId, page: request.page, pageSize: request.pageSize });
    case 'entity-detail': {
      const value = app.entityDetail(request.analysisId, request.entityId, request.revision);
      return { ...value, ...entityDetail(value) };
    }
    case 'correct-entities': return entityDetail(app.correctEntities(request.analysisId, request.revision, request.generation, request.draft, request.reason));
    case 'apply-entities': return candidateDetail(app.reviseUsingEntities(request.id, request.revision, request.generation, request.analysisId, request.entityRevision, request.draft, request.reason, request.identityUncertainties));
    case 'capture': return app.capture({ path: request.source, startRecord: request.startRecord, endRecord: request.endRecord }, signal);
    case 'generate': {
      const run = await app.generate(request.snapshot, configuredExtractionModel(request.executor, request.model), request.runId, signal);
      return extractionRunSummary(run);
    }
    case 'resume': return extractionRunSummary(app.resume(request.id, signal));
    case 'delete-source': app.deleteSource(request.snapshot); return { deleted: request.snapshot };
    case 'maintain': return app.maintain(request.id, request.revision, request.choice, request.reason, request.generation);
    case 'revise': return candidateDetail(app.revise(request.id, request.revision, request.generation, request.draft, request.reason));
  }
}
