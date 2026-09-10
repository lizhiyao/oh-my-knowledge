import { projectReplay, visibleAxisTicks, type ReplayProjection } from '../presentation/knowledge-debugger-renderer.js';
import type { Lang } from '../../shared/language.js';
import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import type { ConversationIndexViewModel, ConversationListItem } from '../../observability/view-models/conversation.js';
import type { KnowledgeDebuggerViewModel } from '../../observability/view-models/knowledge-debugger.js';
import type { ExperienceTurnStatus } from '../../observability/contracts/experience.js';
import { buildKnowledgeDebuggerViewModel } from '../../observability/conversation/knowledge-debugger.js';
import { buildConversationActivitySnapshot, buildConversationDetailActivitySnapshot } from '../presentation/conversation-renderer.js';

export type ObservePage =
  | { pageKind: 'index'; model: ConversationIndexViewModel; revision: string }
  | { pageKind: 'conversation'; model: ConversationListItem; revision: string }
  | { pageKind: 'trajectory'; threadId: string; turnId: string; revision: string; status: ExperienceTurnStatus; live: boolean; replay: ReplayProjection; model: Omit<KnowledgeDebuggerViewModel, 'session'> };

/** Project only the selected task window; do not serialize the full source session. */
export async function loadObservePage(catalog: ConversationCatalog, path: string, lang: Lang): Promise<ObservePage | undefined> {
  if (path === '/observe') {
    const model = await catalog.listConversations();
    return { pageKind: 'index', model, revision: buildConversationActivitySnapshot(model).revision };
  }
  const match = path.match(/^\/observe\/conversations\/([^/]+)(?:\/tasks\/([^/]+))?$/);
  if (!match) return undefined;
  let threadId: string;
  let turnId: string | undefined;
  try { threadId = decodeURIComponent(match[1]); turnId = match[2] === undefined ? undefined : decodeURIComponent(match[2]); }
  catch { return undefined; }
  if (turnId === undefined) {
    const model = await catalog.getConversation(threadId);
    return model ? { pageKind: 'conversation', model, revision: buildConversationDetailActivitySnapshot(model).revision } : undefined;
  }
  const trajectory = await catalog.loadTaskTrajectory(threadId, turnId);
  if (!trajectory) return undefined;
  const view = buildKnowledgeDebuggerViewModel(
    trajectory.session, turnId, trajectory.ingestion, { ...trajectory.sourceRecords, records: [] },
  );
  const live = trajectory.liveObservable && Boolean(catalog.observeTaskTrajectory);
  const replay = projectReplay(view, lang, { pendingToolResults: live });
  replay.axisTicks = visibleAxisTicks(replay);
  const model = { taskScope: view.taskScope, summary: view.summary, steps: view.steps, normalizedEvents: view.normalizedEvents, sourceRecords: view.sourceRecords, knowledgeEvidence: view.knowledgeEvidence, integrity: view.integrity };
  return { pageKind: 'trajectory', threadId, turnId, model, revision: trajectory.revision, status: trajectory.status, live, replay };
}
