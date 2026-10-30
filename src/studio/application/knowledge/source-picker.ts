import { join } from 'node:path';
import { z } from 'zod';
import type { ConversationCatalog } from '../../../observability/application.js';
import { createLocalKnowledgeApplication } from '../../../knowledge/application/local.js';
import { SourceCaptureError, SourceCaptureService } from '../../../knowledge/application/source-capture.js';
import { FileSourceStore } from '../../../knowledge/adapters/source-store.js';
import { readTraceSource } from '../../../knowledge/adapters/trace-source-reader.js';
import { LocalSourceScopeSchema, type LocalSourceScope } from '../../../knowledge/application/local-source-host.js';
import { knowledgeOperationSchemas, executeKnowledgeOperation } from '../../../knowledge/application/operations.js';
import { conversationExtractionSource } from '../../../knowledge/extraction/conversation-source.js';

/** Startup bindings are host data. Browser inventory contains only logical IDs. */
function sourceCatalog(scope?: LocalSourceScope) {
  const value = scope ? LocalSourceScopeSchema.parse(scope) : undefined;
  return { projects: value?.projects.map(({ projectId }) => ({ projectId })) ?? [],
    traces: value?.traces.map(({ sourceId, traceKind, origin }) => ({ sourceId, traceKind, ...(origin ? { title: origin.title } : {}) })) ?? [] };
}
const text = z.string().trim().min(1).max(4096);
const common = { workspace: text };
const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('catalog') }),
  knowledgeOperationSchemas['preview-sources'].extend(common),
  knowledgeOperationSchemas.capture.extend(common),
  knowledgeOperationSchemas['source-updates'].extend(common),
]);
export async function executeSourcePickerAction(input: unknown, scope?: LocalSourceScope, signal?: AbortSignal) {
  const request = requestSchema.parse(input);
  if (request.operation === 'catalog') return sourceCatalog(scope);
  const app = createLocalKnowledgeApplication(request.workspace, { sourceScope: scope });
  return executeKnowledgeOperation(app, request, signal);
}

/** Every request reloads trusted original records. Supplied records retain indexes without inventing file byte offsets. */
export async function previewConversationSource(workspace: string, catalog: ConversationCatalog, threadId: string, turnId?: string,
  recordIndexes?: readonly number[], expectedDigest?: string, signal?: AbortSignal) {
  const source = await conversationExtractionSource(catalog, threadId, turnId, signal, undefined, recordIndexes).catch(cause => {
    if (expectedDigest && cause instanceof Error && cause.message === 'Invalid conversation message selection.') throw new SourceCaptureError('source_changed', 'The confirmed conversation selection is no longer available.');
    throw cause;
  });
  const service = new SourceCaptureService({
    read: (selection, selectedSignal) => {
      if (selection.sourceKind !== 'agent_trace') throw new Error('Invalid conversation source selection.');
      return readTraceSource(selection, { ...source.binding, signal: selectedSignal });
    },
    readResolved: (selection, selectedSignal) => {
      if (selection.sourceKind !== 'agent_trace') throw new Error('Invalid conversation source selection.');
      return readTraceSource(selection, { ...source.binding, signal: selectedSignal });
    },
    currentScopeRevision: () => source.scopeRevision,
    store: new FileSourceStore(join(workspace, 'sources'), workspace),
  });
  const preview = service.previewResolved([source.reading.resolvedSelection], { signal, ...(expectedDigest ? { expectedDigest } : {}) });
  return { service, preview, messages: source.messages, origin: source.origin, sourceVersion: source.reading.sourceVersion };
}
