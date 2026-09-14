import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import { conversationExtractionSource } from './conversation-extraction.js';
import { z } from 'zod';
import { createLocalKnowledgeApplication } from '../../observability/knowledge-extraction/local.js';
import { configuredExtractionModel } from '../../observability/knowledge-extraction/adapters/executor.js';
import type { KnowledgeApplication } from '../../observability/knowledge-extraction/application.js';

const text = z.string().trim().min(1);
const common = { workspace: text };
const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ workspace: z.string().optional(), operation: z.literal('conversations') }),
  z.strictObject({ workspace: z.string().optional(), operation: z.literal('conversation'), threadId: text }),
  z.strictObject({ workspace: z.string().optional(), operation: z.literal('preview-conversation'), threadId: text, turnId: text.optional() }),
  z.strictObject({ ...common, operation: z.literal('capture-conversation'), threadId: text, turnId: text.optional(), sourceVersion: text, recordIndexes: z.array(z.number().int().nonnegative()).min(1).max(1000) }),
  z.strictObject({ ...common, operation: z.literal('related'), threadId: text }),
  z.strictObject({ ...common, operation: z.literal('list') }),
  z.strictObject({ ...common, operation: z.literal('runs') }),
  z.strictObject({ ...common, operation: z.literal('show'), id: text, revision: text.optional() }),
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
    case 'related': return app.runs().flatMap(run => {
      if (run.origin?.threadId !== request.threadId) return [];
      return [{ runId: run.runId, status: run.status, startedAt: run.startedAt, committed: run.committed.map(ref => {
        const detail = app.detail(ref.knowledgeId);
        return { ...ref, title: detail.revision.title, choice: detail.maintenance?.choice ?? null };
      }) }];
    });
    case 'list': return app.list();
    case 'runs': return app.runs().sort((a, b) => (Date.parse(b.startedAt) - Date.parse(a.startedAt)) || a.runId.localeCompare(b.runId)).map(({ runId, status, startedAt, committed, rejections }) => ({ runId, status, startedAt, committed, rejections }));
    case 'show': return { ...app.detail(request.id, request.revision), origin: app.runs().find(run => run.committed.some(ref => ref.knowledgeId === request.id))?.origin };
    case 'capture': return app.capture({ path: request.source, startRecord: request.startRecord, endRecord: request.endRecord }, signal);
    case 'generate': {
      const run = await app.generate(request.snapshot, configuredExtractionModel(request.executor, request.model), request.runId, signal);
      return { runId: run.runId, status: run.status, committed: run.committed, rejections: run.rejections };
    }
    case 'resume': { const run = app.resume(request.id, signal); return { runId: run.runId, status: run.status, committed: run.committed, rejections: run.rejections }; }
    case 'delete-source': app.deleteSource(request.snapshot); return { deleted: request.snapshot };
    case 'maintain': return app.maintain(request.id, request.revision, request.choice, request.reason, request.generation);
    case 'revise': return app.revise(request.id, request.revision, request.generation, request.draft, request.reason);
  }
}
