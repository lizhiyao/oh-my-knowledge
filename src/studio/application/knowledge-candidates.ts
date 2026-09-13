import { z } from 'zod';
import { createLocalKnowledgeApplication } from '../../observability/knowledge-extraction/local.js';
import { configuredExtractionModel } from '../../observability/knowledge-extraction/adapters/executor.js';
import type { KnowledgeApplication } from '../../observability/knowledge-extraction/application.js';

const text = z.string().trim().min(1);
const common = { workspace: text };
const requestSchema = z.discriminatedUnion('operation', [
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
  create: (root: string) => KnowledgeApplication = createLocalKnowledgeApplication): Promise<unknown> {
  const request = requestSchema.parse(input);
  const app = create(request.workspace);
  switch (request.operation) {
    case 'list': return app.list();
    case 'runs': return app.runs().map(({ runId, status, startedAt, committed, rejections }) => ({ runId, status, startedAt, committed, rejections }));
    case 'show': return app.detail(request.id, request.revision);
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
