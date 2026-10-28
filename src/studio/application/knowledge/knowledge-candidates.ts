import { createExtractionArchiveProducer } from '../../../executors/archive.js';
import { type ConversationCatalog } from '../../../observability/application.js';
import { createLocalKnowledgeApplication } from '../../../knowledge/application/local.js';
import { configuredKnowledgeGenerationModel } from '../../../knowledge/adapters/generation-executor.js';
import type { GenerationJournal } from '../../../knowledge/extraction/generation-journal.js';
import { type KnowledgeApplication } from '../../../knowledge/application/application.js';
import { type KnowledgeOperation, executeKnowledgeOperation, knowledgeOperationSchemas } from '../../../knowledge/application/operations.js';
import { conversationExtractionSource } from '../conversations/conversation-extraction.js';
import { z } from 'zod';
import type { KnowledgeCandidateDetail, KnowledgeEntityAnalysisDetail, KnowledgeCandidateRun } from '../../view-models/knowledge/knowledge-candidates.js';

const text = z.string().trim().min(1);
const common = { workspace: text };
function entityDetail(detail: ReturnType<KnowledgeApplication['entities']>): KnowledgeEntityAnalysisDetail {
  return { ...detail, source: detail.source.status === 'available'
    ? { status: 'available', excerpts: detail.source.window.excerpts, limitations: detail.source.window.limitations } : detail.source };
}
function candidateDetail(detail: ReturnType<KnowledgeApplication['detail']>): KnowledgeCandidateDetail { return detail; }
function runSummary(app: KnowledgeApplication, journal: GenerationJournal): KnowledgeCandidateRun {
  const last = journal.stages.at(-1)!, source = app.source(journal.snapshotId, journal.sourceVersion);
  const pending = journal.stages.find(s => !['completed', 'failed'].includes(s.state));
  const association = journal.stages.find(s => s.stageKind === 'association'), catalog = association?.committed ? association.entityWrite : undefined;
  return { runId: journal.runId, schemaStatus: 'current', status: journal.status, createdAt: journal.createdAt,
    executor: journal.executor, model: journal.model, snapshotId: journal.snapshotId, sourceVersion: journal.sourceVersion,
    ...(source.status === 'available' && source.window.origin ? { origin: source.window.origin } : {}), bodies: journal.bodies,
    phases: journal.stages.map(s => ({ stageKind: s.stageKind, state: s.state, invocationId: s.invocationId, profileId: s.profileId,
      promptVersion: s.promptVersion, wireId: s.wireId, ...(s.outcomeRef ? { outcomeRef: s.outcomeRef } : {}), committed: s.committed,
      issues: s.issues, producerId: s.producer.producerId, producerRevision: s.producer.producerRevision, rejectedCount: s.rejected?.length ?? null })),
    nextAction: pending?.state === 'prepared' ? 'continue_stage' : pending?.state === 'claimed' ? 'outcome_unknown_do_not_redispatch'
      : pending ? 'resume_publication' : journal.status === 'active' && last.state === 'completed' ? 'continue_stage' : 'none',
    ...(catalog ? { entityAnalysis: { analysisId: catalog.analysisId, revisionId: catalog.revision.revisionId,
      entityCount: catalog.revision.entities.length, mentionCount: catalog.revision.mentions.length,
      unresolvedCount: catalog.revision.entities.filter(e => e.identityStatus === 'unresolved').length, reviewStatus: 'pending' as const } } : {}) };
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
  knowledgeOperationSchemas['apply-associations'].extend(common),
  knowledgeOperationSchemas['review-associations'].extend(common),
  knowledgeOperationSchemas['inspect'].extend(common),
  knowledgeOperationSchemas['continue-stage'].extend(common),
  knowledgeOperationSchemas['rebuild-associations'].extend(common),
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
  const execute = <C extends KnowledgeOperation>(command: C) => executeKnowledgeOperation(app, command, signal, (executor, model) => configuredKnowledgeGenerationModel(executor, model, createExtractionArchiveProducer(process.env)));
  switch (request.operation) {
    case 'queue': {
      if (request.threadId && request.projectId) throw new Error('Select one knowledge scope.');
      const projectThreads = request.projectId && catalog ? new Set((await catalog.listConversations()).conversations
        .filter(item => (item.project?.projectId ?? item.cwd) === request.projectId).map(item => item.threadId)) : undefined;
      if (request.projectId && !catalog) throw new Error('Conversation catalog unavailable.');
      const runs = app.runs().current.map(j => runSummary(app, j)).filter(run => request.threadId ? run.origin?.threadId === request.threadId
        : projectThreads ? Boolean(run.origin && projectThreads.has(run.origin.threadId)) : true);
      const ids = new Set(runs.flatMap(run => run.bodies.map(ref => ref.knowledgeId)));
      return { rows: app.list(ids), runs };
    }
    case 'quality': return execute(request);
    case 'list': return execute(request);
    case 'tag': return execute(request);
    case 'runs': { const inventory = await execute(request); return [
      ...inventory.current.map(j => runSummary(app, j)).sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!) || a.runId.localeCompare(b.runId)),
      ...inventory.unsupported.map(item => ({ runId: item.runId, schemaStatus: 'unsupported' as const, status: 'unsupported' as const,
        bodies: [], phases: [], nextAction: 'unsupported' as const, unsupportedReason: item.reason })),
    ]; }
    case 'show': {
      const detail = candidateDetail(await execute(request));
      const origin = detail.sources.find(source => source.status === 'available');
      return { ...detail, ...(origin?.status === 'available' && origin.window.origin ? { origin: origin.window.origin } : {}) };
    }
    case 'entities': return entityDetail(await execute(request));
    case 'entity-catalog': return execute(request);
    case 'entity-detail': {
      const value = await execute(request);
      return { ...value, ...entityDetail(value) };
    }
    case 'correct-entities': return entityDetail(await execute(request));
    case 'apply-associations': case 'review-associations': return candidateDetail(await execute(request));
    case 'capture': return execute(request);
    case 'generate': case 'resume': case 'continue-stage': case 'rebuild-associations': return runSummary(app, (await execute(request)).journal);
    case 'inspect': return runSummary(app, app.inspect(request.id).journal);
    case 'delete-source': return execute(request);
    case 'maintain': return execute(request);
    case 'revise': return candidateDetail(await execute(request));
  }
}
