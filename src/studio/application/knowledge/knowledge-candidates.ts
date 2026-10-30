import { createExtractionArchiveProducer } from '../../../executors/archive.js';
import { sourceView } from './source-view.js';
import { assertSourceWorkspaceWritable } from '../../../knowledge/adapters/source-workspace.js';
import { type ConversationCatalog } from '../../../observability/application.js';
import { createLocalKnowledgeApplication } from '../../../knowledge/application/local.js';
import { generationNextAction } from '../../../knowledge/application/body-generation.js';
import { createLocalKnowledgeGenerationModel } from '../../../knowledge/adapters/generation-host.js';
import type { GenerationArchiveCheck, GenerationJournal, GenerationJournalInventory } from '../../../knowledge/extraction/generation-journal.js';
import { type KnowledgeApplication } from '../../../knowledge/application/application.js';
import { KnowledgeGraphRequestSchema } from '../../../knowledge/application/graph.js';
import { type KnowledgeOperation, executeKnowledgeOperation, knowledgeOperationSchemas } from '../../../knowledge/application/operations.js';
import { previewConversationSource } from './source-picker.js';
import { SourceDigestSchema, SourceIdentitySchema } from '../../../knowledge/sources.js';
import { z } from 'zod';
import type { KnowledgeCandidateDetail, KnowledgeEntityAnalysisDetail, KnowledgeCandidateRun } from '../../view-models/knowledge/knowledge-candidates.js';

const text = z.string().trim().min(1);
const common = { workspace: text };
function entityDetail(detail: ReturnType<KnowledgeApplication['entities']>): KnowledgeEntityAnalysisDetail {
  return { ...detail, source: sourceView(detail.source) };
}
function candidateDetail(detail: ReturnType<KnowledgeApplication['detail']>): KnowledgeCandidateDetail { return { ...detail, sources: detail.sources.map(sourceView) }; }
const frozenSourceSchema = z.object({ source: z.object({ snapshotId: z.string(), sourceVersion: z.string(),
  sourceKind: z.enum(['agent_trace', 'project_file', 'git_blob']), identity: z.record(z.string(), z.unknown()),
  origin: z.object({ threadId: z.string().min(1), title: z.string(), turnId: z.string().min(1).optional() }).optional() }) });
/** Frozen attribution is metadata only; it does not assert that the sources can still be read. */
function frozenSourceMetadata(journal: GenerationJournal): Pick<KnowledgeCandidateRun, 'sources' | 'sourceMetadataStatus'> {
  const sources = journal.sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion }));
  try {
    const input: unknown = JSON.parse(journal.stages[0]!.input);
    const entries = z.object({ sources: z.array(frozenSourceSchema) }).parse(input).sources;
    if (entries.length !== sources.length || entries.some(({ source }, index) => source.snapshotId !== sources[index].snapshotId || source.sourceVersion !== sources[index].sourceVersion)) return { sources, sourceMetadataStatus: 'unknown' };
    return { sources: entries.map(({ source }) => {
      const identity = SourceIdentitySchema.parse({ ...source.identity, sourceKind: source.sourceKind });
      return { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion, sourceKind: identity.sourceKind,
        ...(identity.sourceKind === 'agent_trace' ? {} : { projectId: identity.projectId }), ...(source.origin ? { origin: source.origin } : {}) };
    }), sourceMetadataStatus: 'frozen_input' };
  } catch { return { sources, sourceMetadataStatus: 'unknown' }; }
}
function runSummary(journal: GenerationJournal, archiveChecks: GenerationArchiveCheck[] = [], archiveVerification: KnowledgeCandidateRun['archiveVerification'] = 'not_verified'): KnowledgeCandidateRun {
  const nextAction = generationNextAction(journal);
  const association = journal.stages.find(s => s.stageKind === 'association'), catalogs = association?.entityWrites?.slice(0, association.committed) ?? [];
  const prepared = journal.stages.at(-1);
  return { runId: journal.runId, journalGeneration: journal.generation, workflowId: journal.workflowId, inputVersion: journal.inputVersion, sourceSetId: journal.sourceSetId,
    ...(nextAction === 'continue_stage' && prepared?.state === 'prepared' ? { preparedStage: prepared } : {}), schemaStatus: 'current', status: journal.status, createdAt: journal.createdAt,
    executor: journal.executor, model: journal.model,
    ...frozenSourceMetadata(journal), archiveChecks, archiveVerification, bodies: journal.bodies,
    phases: journal.stages.map(s => ({ stageKind: s.stageKind, state: s.state, invocationId: s.invocationId, profileId: s.profileId,
      promptVersion: s.promptVersion, wireId: s.wireId, ...(s.outcomeRef ? { outcomeRef: s.outcomeRef } : {}), committed: s.committed,
      issues: s.issues, producerId: s.producer.producerId, producerRevision: s.producer.producerRevision, rejectedCount: s.rejected?.length ?? null })),
    nextAction,
    ...(nextAction === 'unsupported' ? { unsupportedReason: 'generation_profile_changed_use_matching_build' } : {}),
    ...(catalogs.length ? { entityAnalyses: catalogs.map(catalog => ({ analysisId: catalog.analysisId, revisionId: catalog.revision.revisionId,
      entityCount: catalog.revision.entities.length, mentionCount: catalog.revision.mentions.length,
      unresolvedCount: catalog.revision.entities.filter(e => e.identityStatus === 'unresolved').length, reviewStatus: 'pending' as const })) } : {}) };
}
function inventoryRuns(inventory: GenerationJournalInventory): KnowledgeCandidateRun[] {
  const checks = new Map<string, GenerationArchiveCheck[]>();
  for (const check of inventory.archiveChecks) checks.set(check.runId, [...(checks.get(check.runId) ?? []), check]);
  return [
    ...inventory.current.map(j => runSummary(j, checks.get(j.runId))).sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!) || a.runId.localeCompare(b.runId)),
    ...inventory.unsupported.map(item => ({ runId: item.runId, schemaStatus: 'unsupported' as const, status: 'unsupported' as const,
      bodies: [], phases: [], nextAction: 'unsupported' as const, unsupportedReason: item.reason, archiveChecks: [], archiveVerification: 'not_verified' as const })),
    ...inventory.unavailable.map(item => ({ runId: item.runId, schemaStatus: 'unavailable' as const, status: 'unavailable' as const,
      bodies: [], phases: [], nextAction: 'unavailable' as const, unavailableReason: item.reason, archiveChecks: [], archiveVerification: 'not_verified' as const })),
  ];
}
function unavailableSourceScope(run: KnowledgeCandidateRun, reason: 'invalid_source_metadata' | 'project_membership_unavailable' = 'invalid_source_metadata'): KnowledgeCandidateRun {
  return { runId: run.runId, schemaStatus: 'unavailable', status: 'unavailable', bodies: [], phases: [],
    sourceMetadataStatus: reason === 'project_membership_unavailable' ? run.sourceMetadataStatus : 'unknown', unavailableReason: reason, nextAction: 'unavailable',
    archiveChecks: run.archiveChecks, archiveVerification: 'not_verified' };
}
const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ workspace: z.string().optional(), operation: z.literal('conversations') }),
  z.strictObject({ workspace: z.string().optional(), operation: z.literal('conversation'), threadId: text }),
  z.strictObject({ ...common, operation: z.literal('preview-conversation'), threadId: text, turnId: text.optional(), recordIndexes: z.array(z.number().int().nonnegative()).min(1).max(1000).optional() }),
  z.strictObject({ ...common, operation: z.literal('capture-conversation'), threadId: text, turnId: text.optional(), previewDigest: SourceDigestSchema, recordIndexes: z.array(z.number().int().nonnegative()).min(1).max(1000) }),
  z.strictObject({ ...common, operation: z.literal('queue'), threadId: text.optional(), projectId: text.optional() }),
  KnowledgeGraphRequestSchema.extend({ ...common, operation: z.literal('graph') }),
  z.strictObject({ ...common, operation: z.literal('association-catalogs'), id: text, revision: text.optional() }),
  knowledgeOperationSchemas['list'].extend(common),
  knowledgeOperationSchemas['tag'].extend(common),
  knowledgeOperationSchemas['runs'].extend(common),
  knowledgeOperationSchemas['quality'].extend(common),
  knowledgeOperationSchemas.retrieve.safeExtend({ ...common, format: z.literal('json').optional() }),
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
  knowledgeOperationSchemas['prepare-generation'].extend(common),
  knowledgeOperationSchemas['prepare-rebuild-associations'].extend(common),
  knowledgeOperationSchemas['generate'].extend(common),
  knowledgeOperationSchemas['resume'].extend(common),
  knowledgeOperationSchemas['source'].extend(common),
  knowledgeOperationSchemas['delete-source'].extend(common),
  knowledgeOperationSchemas['maintain'].extend(common),
  knowledgeOperationSchemas['revise'].extend(common),
]);

export async function executeKnowledgeCandidateAction(input: unknown, signal?: AbortSignal,
  create: (root: string) => KnowledgeApplication = createLocalKnowledgeApplication, catalog?: ConversationCatalog): Promise<unknown> {
  const request = requestSchema.parse(input);
  if (request.operation === 'conversations') {
    if (!catalog) throw new Error('Conversation catalog unavailable.');
    return (await catalog.listConversations()).conversations.map(({ threadId, title }) => ({ threadId, title }));
  }
  if (request.operation === 'conversation') {
    if (!catalog) throw new Error('Conversation catalog unavailable.');
    const conversation = await catalog.getConversation(request.threadId);
    if (!conversation) throw new Error('Conversation unavailable.');
    return { threadId: conversation.threadId, title: conversation.title, tasks: conversation.tasks.map(({ turnId, sourceTurnId, title }) => ({ turnId: sourceTurnId ?? turnId, title })) };
  }
  if (request.operation === 'preview-conversation' || request.operation === 'capture-conversation') {
    if (!catalog) throw new Error('Conversation catalog unavailable.');
    const local = await previewConversationSource(request.workspace, catalog, request.threadId, request.turnId,
      request.recordIndexes, request.operation === 'capture-conversation' ? request.previewDigest : undefined, signal);
    if (request.operation === 'preview-conversation') return { origin: local.origin, sourceVersion: local.sourceVersion,
      messages: local.messages, preview: local.preview };
    assertSourceWorkspaceWritable(request.workspace);
    return local.service.capture({ previewId: local.preview.previewId, previewDigest: local.preview.previewDigest }, { signal });
  }
  const app = create(request.workspace);
  const execute = <C extends KnowledgeOperation>(command: C) => executeKnowledgeOperation(app, command, signal, (executor, model) => createLocalKnowledgeGenerationModel(executor, model, createExtractionArchiveProducer));
  switch (request.operation) {
    case 'graph': return app.graph({ knowledgeIds: request.knowledgeIds, includeHistory: request.includeHistory });
    case 'association-catalogs': return app.associationCatalogs(request.id, request.revision);
    case 'queue': {
      if (request.threadId && request.projectId) throw new Error('Select one knowledge scope.');
      let projectThreads: Set<string> | undefined, projectMembershipKnown = !request.projectId;
      if (request.projectId && catalog) {
        try { projectThreads = new Set((await catalog.listConversations()).conversations
          .filter(item => (item.project?.projectId ?? item.cwd) === request.projectId).map(item => item.threadId)); projectMembershipKnown = true; }
        catch { projectMembershipKnown = false; }
      }
      const runs = inventoryRuns(app.runs()).flatMap(run => {
        if (run.schemaStatus !== 'current') return [run];
        if ((request.threadId || request.projectId) && run.sourceMetadataStatus === 'unknown') return [unavailableSourceScope(run)];
        if (request.threadId) return run.sources?.some(source => source.origin?.threadId === request.threadId) ? [run] : [];
        if (request.projectId) {
          if (run.sources?.some(source => source.projectId === request.projectId
            || source.origin && projectThreads?.has(source.origin.threadId))) return [run];
          if (!projectMembershipKnown && run.sources?.some(source => source.sourceKind === 'agent_trace' && source.origin)) return [unavailableSourceScope(run, 'project_membership_unavailable')];
          return [];
        }
        return [run];
      });
      const ids = new Set(runs.flatMap(run => run.bodies.map(ref => ref.knowledgeId)));
      return { rows: app.list(ids), runs };
    }
    case 'quality': return execute(request);
    case 'retrieve': return execute(request);
    case 'list': return execute(request);
    case 'tag': return execute(request);
    case 'runs': return inventoryRuns(await execute(request));
    case 'show': {
      const detail = candidateDetail(await execute(request));
      const origin = detail.sources.find(source => source.status === 'available');
      return { ...detail, ...(origin?.status === 'available' && origin.snapshot.sourceKind === 'agent_trace' && origin.snapshot.origin ? { origin: origin.snapshot.origin } : {}) };
    }
    case 'entities': return entityDetail(await execute(request));
    case 'entity-catalog': return execute(request);
    case 'entity-detail': {
      const value = await execute(request);
      return { ...value, ...entityDetail(value) };
    }
    case 'correct-entities': return entityDetail(await execute(request));
    case 'apply-associations': case 'review-associations': return candidateDetail(await execute(request));
    case 'prepare-generation': case 'prepare-rebuild-associations': case 'generate': case 'resume': case 'continue-stage': case 'rebuild-associations': return runSummary((await execute(request)).journal);
    case 'inspect': {
      const { journal } = app.inspect(request.id);
      return runSummary(journal, [], journal.stages.every(stage => stage.outcomeRef) ? 'verified' : 'not_verified');
    }
    case 'source': case 'delete-source': return execute(request);
    case 'maintain': return execute(request);
    case 'revise': return candidateDetail(await execute(request));
  }
}
