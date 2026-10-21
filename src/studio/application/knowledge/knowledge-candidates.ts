import { createExtractionArchiveProducer } from '../../../executors/archive.js';
import { type ConversationCatalog } from '../../../observability/application.js';
import { createLocalKnowledgeApplication } from '../../../knowledge/application/local.js';
import { configuredExtractionModel } from '../../../knowledge/adapters/executor.js';
import { extractionRunSummary } from '../../../knowledge/extraction/runs.js';
import { type KnowledgeApplication } from '../../../knowledge/application/application.js';
import { type KnowledgeOperation, executeKnowledgeOperation, knowledgeOperationSchemas } from '../../../knowledge/application/operations.js';
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
  knowledgeOperationSchemas['list'].extend(common),
  knowledgeOperationSchemas['tag'].extend(common),
  knowledgeOperationSchemas['runs'].extend(common),
  knowledgeOperationSchemas['quality'].extend(common),
  knowledgeOperationSchemas['show'].extend(common),
  knowledgeOperationSchemas['entities'].extend(common),
  knowledgeOperationSchemas['entity-catalog'].extend(common),
  knowledgeOperationSchemas['entity-detail'].extend(common),
  knowledgeOperationSchemas['correct-entities'].extend(common),
  knowledgeOperationSchemas['apply-entities'].extend(common),
  knowledgeOperationSchemas['capture'].extend(common),
  knowledgeOperationSchemas['generate'].extend({ ...common, runId: z.string().uuid() }),
  knowledgeOperationSchemas['resume'].extend(common),
  knowledgeOperationSchemas['delete-source'].extend(common),
  knowledgeOperationSchemas['maintain'].extend(common),
  knowledgeOperationSchemas['revise'].extend(common),
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
  const execute = <C extends KnowledgeOperation>(command: C) => executeKnowledgeOperation(app, command, signal, (executor, model, policy) => configuredExtractionModel(executor, model,
    createExtractionArchiveProducer(process.env), policy?.policyId === 'knowledge-generation-bounded/v1' ? { maxOutputTokens: policy.maxOutputTokens } : undefined));
  switch (request.operation) {
    case 'queue': {
      if (request.threadId && request.projectId) throw new Error('Select one knowledge scope.');
      const projectThreads = request.projectId && catalog ? new Set((await catalog.listConversations()).conversations
        .filter(item => (item.project?.projectId ?? item.cwd) === request.projectId).map(item => item.threadId)) : undefined;
      if (request.projectId && !catalog) throw new Error('Conversation catalog unavailable.');
      const runs = app.runs().filter(run => request.threadId ? run.origin?.threadId === request.threadId
        : projectThreads ? Boolean(run.origin && projectThreads.has(run.origin.threadId)) : true);
      const ids = new Set(runs.flatMap(run => run.committed.map(ref => ref.knowledgeId)));
      return { rows: app.list(ids), runs: runs.map(extractionRunSummary) };
    }
    case 'quality': return execute(request);
    case 'list': return execute(request);
    case 'tag': return execute(request);
    case 'runs': return (await execute(request)).sort((a, b) => (Date.parse(b.startedAt) - Date.parse(a.startedAt)) || a.runId.localeCompare(b.runId)).map(extractionRunSummary);
    case 'show': return { ...candidateDetail(await execute(request)), origin: app.runs().find(run => run.committed.some(ref => ref.knowledgeId === request.id))?.origin };
    case 'entities': return entityDetail(await execute(request));
    case 'entity-catalog': return execute(request);
    case 'entity-detail': {
      const value = await execute(request);
      return { ...value, ...entityDetail(value) };
    }
    case 'correct-entities': return entityDetail(await execute(request));
    case 'apply-entities': return candidateDetail(await execute(request));
    case 'capture': return execute(request);
    case 'generate': {
      const run = await execute(request);
      return extractionRunSummary(run);
    }
    case 'resume': return extractionRunSummary(await execute(request));
    case 'delete-source': return execute(request);
    case 'maintain': return execute(request);
    case 'revise': return candidateDetail(await execute(request));
  }
}
