import { z } from 'zod';
import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import type { KnowledgeGenerationModel } from './application.js';

/** Legacy grant identity only. It never authorizes workflow4 or a new automatic permission. */
export const AUTO_EXTRACTION_WORKFLOW = 'knowledge-body-first/v3' as const;
const text = z.string().min(1).max(4096);
/** Recognize stale host requests so they can be refused; no permission document is created. */
export const AutoExtractionConsentSchema = z.strictObject({
  workflowId: z.literal(AUTO_EXTRACTION_WORKFLOW), token: text, executor: z.enum(['codex', 'openai-api']), model: text,
  maxCalls: z.number().int().min(1).max(20),
});
/** Runtime availability, not a persisted automation state or an upgraded schema3 permission. */
export interface AutoExtractionState {
  schemaStatus: 'unsupported'; threadId: string; enabled: false; reason: 'explicit_stages_required';
}
export type AutoExtractionStatus = AutoExtractionState;
export type AutoExtractionPreview = AutoExtractionStatus;

function scope(root: string, threadId: string): void {
  if (!root.trim() || !threadId.trim()) throw new Error('Explicit auto-extraction scope required.');
}
function unsupported(threadId: string): AutoExtractionStatus {
  return { schemaStatus: 'unsupported', threadId, enabled: false, reason: 'explicit_stages_required' };
}

/** Workflow4 executes only explicitly confirmed stages. Old schedules and claims belong to their preserved build. */
export class ConversationAutoExtraction {
  constructor(catalog: ConversationCatalog, options: {
    now?: () => number; stableMs?: number; intervalMs?: number; model(executor: string, model: string): KnowledgeGenerationModel;
  }) {
    // Keep the host composition shape without reading the catalog, creating a model or installing a timer.
    void catalog; void options;
  }
  async preview(threadId: string, target: { executor: string; model: string }, signal?: AbortSignal): Promise<AutoExtractionPreview> {
    void threadId; void target; void signal;
    throw new Error('explicit_stages_required');
  }
  async enable(root: string, threadId: string, input: z.infer<typeof AutoExtractionConsentSchema>, signal?: AbortSignal): Promise<AutoExtractionStatus> {
    void root; void threadId; void input; void signal;
    throw new Error('explicit_stages_required');
  }
  status(root: string, threadId: string): AutoExtractionStatus {
    scope(root, threadId); return unsupported(threadId);
  }
  stop(root: string, threadId: string): AutoExtractionStatus {
    // There is no current scheduler to stop. Never edit an old permission or reconcile/refund its claims.
    return this.status(root, threadId);
  }
  tick(): Promise<void> {
    return Promise.resolve(); // No roots, reservations, models, configuration or native dispatch.
  }
  close(): void {
    // No timer or in-flight task is created by this implementation; old evidence is left untouched.
  }
}
