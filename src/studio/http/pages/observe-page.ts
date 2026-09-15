import { projectReplay } from '../../application/conversations/replay/projection.js';
import { visibleAxisTicks } from '../../application/conversations/replay/layout.js';
import { type ReplayProjection } from '../../view-models/conversations/replay.js';
import type { Lang } from '../../../shared/language.js';
import type { ConversationCatalog } from '../../../observability/conversation/catalog.js';
import type { ConversationIndexViewModel, ConversationListItem } from '../../../observability/view-models/conversation.js';
import type { KnowledgeDebuggerViewModel } from '../../../observability/view-models/knowledge-debugger.js';
import type { ExperienceTurnStatus } from '../../../observability/contracts/experience.js';
import { buildKnowledgeDebuggerViewModel } from '../../../observability/conversation/knowledge-debugger.js';
import { buildConversationActivitySnapshot, buildConversationDetailActivitySnapshot } from '../../application/conversations/conversation-activity.js';
import { OBSERVE_CONVERSATION_PREFIX, OBSERVE_INDEX_PATH } from '../page-paths.js';

export type ObservePage =
  | { pageKind: 'index'; model: ConversationIndexViewModel; revision: string }
  | { pageKind: 'conversation'; model: ConversationListItem; navigation: ConversationIndexViewModel; revision: string }
  | { pageKind: 'trajectory'; threadId: string; turnId: string; revision: string; status: ExperienceTurnStatus; live: boolean; replay: ReplayProjection; model: Omit<KnowledgeDebuggerViewModel, 'session'> };

/** 地址识别属装载器；收件箱另由 `inbox-page.ts` 识别，宿主按 `observationInbox` 开关单独决定接不接管。 */
export function isObservePath(path: string): boolean {
  return path === OBSERVE_INDEX_PATH || path.startsWith(OBSERVE_CONVERSATION_PREFIX);
}

/** Project only the selected task window; do not serialize the full source session. */
export async function loadObservePage(catalog: ConversationCatalog, path: string, lang: Lang): Promise<ObservePage | undefined> {
  if (path === OBSERVE_INDEX_PATH) {
    const model = await catalog.listConversations();
    return { pageKind: 'index', model, revision: buildConversationActivitySnapshot(model).revision };
  }
  if (!path.startsWith(OBSERVE_CONVERSATION_PREFIX)) return undefined;
  const match = path.slice(OBSERVE_CONVERSATION_PREFIX.length).match(/^([^/]+)(?:\/tasks\/([^/]+))?$/);
  if (!match) return undefined;
  let threadId: string;
  let turnId: string | undefined;
  try { threadId = decodeURIComponent(match[1]); turnId = match[2] === undefined ? undefined : decodeURIComponent(match[2]); }
  catch { return undefined; }
  if (turnId === undefined) {
    const model = await catalog.getConversation(threadId);
    return model ? { pageKind: 'conversation', model, navigation: await catalog.listConversations(), revision: buildConversationDetailActivitySnapshot(model).revision } : undefined;
  }
  const trajectory = await catalog.loadTaskTrajectory(threadId, turnId);
  if (!trajectory) return undefined;
  const view = buildKnowledgeDebuggerViewModel(
    trajectory.session, turnId, trajectory.ingestion, { ...trajectory.sourceRecords, records: [] },
  );
  // 数据可跟随（liveObservable）与宿主有实时源（observeTaskTrajectory）是两个轴：DSH 的快照目录
  // 只有前者，页面因此不给一个按下去跟不住任何事情的开关（#902 §四）。
  const live = trajectory.liveObservable && Boolean(catalog.observeTaskTrajectory);
  const replay = projectReplay(view, lang, { pendingToolResults: live });
  replay.axisTicks = visibleAxisTicks(replay);
  const model = { taskScope: view.taskScope, summary: view.summary, steps: view.steps, normalizedEvents: view.normalizedEvents, sourceRecords: view.sourceRecords, knowledgeEvidence: view.knowledgeEvidence, integrity: view.integrity };
  return { pageKind: 'trajectory', threadId, turnId, model, revision: trajectory.revision, status: trajectory.status, live, replay };
}
