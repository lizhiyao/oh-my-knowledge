import type { ConversationListItem } from '../../../observability/view-models/conversation.js';

/**
 * 侧栏与列表的默认视野。截断只是视野收窄，不是内容消失：被截掉的部分必须留下可达入口，
 * 否则较早的会话在侧栏里彻底失联，只能靠用户猜「全部对话」还在。
 */
export const PROJECT_LIMIT = 6;
export const PROJECT_SESSION_LIMIT = 12;
export const INDEPENDENT_LIMIT = 15;
export const LIST_PAGE_SIZE = 20;

export interface ProjectWindow {
  all: boolean;
  searching: boolean;
  selectedId?: string;
  activeId?: string;
}

/** 默认只给前 6 个项目；展开、搜索、当前打开或正在查看的项目始终留在视野内。 */
export function visibleProjectIds(ids: string[], window: ProjectWindow): string[] {
  return ids.filter((id, index) => window.all || window.searching || index < PROJECT_LIMIT || id === window.selectedId || id === window.activeId);
}

/** 截断后把正在看的那一条补回视野：用户点开一个会话，侧栏却找不到它，等于失去当前所在位置的坐标。 */
export function keepSelectedVisible(shown: ConversationListItem[], candidates: ConversationListItem[], selected?: ConversationListItem): ConversationListItem[] {
  if (!selected) return shown;
  const inCandidates = candidates.some(item => item.threadId === selected.threadId);
  const inShown = shown.some(item => item.threadId === selected.threadId);
  return inCandidates && !inShown ? [...shown, selected] : shown;
}

/** 页码夹回有效区间：搜索或切换视图让总数变少时，停在越界页只会看到一张空列表。 */
export function listPage<T>(rows: T[], current: number, pageSize: number = LIST_PAGE_SIZE): { rows: T[]; page: number } {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, current), pages);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), page };
}
