import type { ConversationReaderPage } from '../../view-models/conversations/conversation-reader.js';

type Turn = ConversationReaderPage['turns'][number];

/** 每次只读一小页轮次；游标按 turnId 定位，追加新轮次不会移动历史窗口。 */
export const READER_PAGE_LIMIT = 5;
/** 距底部小于该像素值视为跟随最新，新消息不再打断阅读。 */
export const FOLLOW_THRESHOLD = 48;
/** 向上滚到该像素值以内即补一页历史。 */
export const HISTORY_THRESHOLD = 80;

export interface ReadingFrame {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** bottom 表示贴到最新；height/top 表示记住补历史前的位置，等内容变高后还原。 */
export type ReadingAnchor = { bottom: true } | { height: number; top: number };

export function isFollowing(frame: ReadingFrame, threshold: number = FOLLOW_THRESHOLD): boolean {
  return frame.scrollHeight - frame.scrollTop - frame.clientHeight < threshold;
}

export function shouldLoadOlder(frame: ReadingFrame, state: { hasOlder: boolean; busy: boolean; failed: boolean }, threshold: number = HISTORY_THRESHOLD): boolean {
  return frame.scrollTop < threshold && state.hasOlder && !state.busy && !state.failed;
}

export function readingAnchor(mode: 'older' | 'latest', frame: ReadingFrame | null, following: boolean): ReadingAnchor | null {
  if (mode === 'older' && frame) return { height: frame.scrollHeight, top: frame.scrollTop };
  return following ? { bottom: true } : null;
}

export function resolveAnchorTop(anchor: ReadingAnchor, scrollHeight: number): number {
  return 'bottom' in anchor ? scrollHeight : anchor.top + scrollHeight - anchor.height;
}

/** Map 保留首次插入的位置、取最后写入的值：older 时旧页在前，重复轮次以已加载的那份为准。 */
export function mergeTurns(existing: Turn[], incoming: Turn[], mode: 'older' | 'latest'): Turn[] {
  const ordered = mode === 'older' ? [...incoming, ...existing] : [...existing, ...incoming];
  const merged = new Map<string, Turn>();
  for (const turn of ordered) merged.set(turn.task.turnId, turn);
  return [...merged.values()];
}

/**
 * 内容没变就不落 state、也不记锚点：否则每次轮询都会把正在读历史的用户拽走。
 * 比对成本随已加载窗口增长，不随会话总轮次增长。
 */
export function turnsChanged(next: Turn[], existing: Turn[]): boolean {
  return JSON.stringify(next) !== JSON.stringify(existing);
}
