import { describe, expect, it } from 'vitest';
import type { ConversationReaderPage } from '../../../src/studio/view-models/conversations/conversation-reader.js';
import {
  FOLLOW_THRESHOLD, HISTORY_THRESHOLD, READER_PAGE_LIMIT,
  isFollowing, mergeTurns, readingAnchor, resolveAnchorTop, shouldLoadOlder, turnsChanged,
} from '../../../src/studio/application/conversations/reader-viewport.js';

type Turn = ConversationReaderPage['turns'][number];
const turn = (turnId: string, extra: Partial<Turn> = {}): Turn => ({ task: { turnId } as Turn['task'], messages: [], unavailable: false, ...extra });
const ids = (turns: Turn[]) => turns.map(item => item.task.turnId);

describe('跟随判定', () => {
  it('距底部小于阈值即视为跟随最新', () => {
    expect(isFollowing({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isFollowing({ scrollHeight: 1000, scrollTop: 600 - FOLLOW_THRESHOLD, clientHeight: 400 })).toBe(false);
  });
});

describe('向上补历史', () => {
  it('只在滚到顶部附近、确有更早内容、且当前空闲时触发', () => {
    const frame = { scrollHeight: 1000, scrollTop: HISTORY_THRESHOLD - 1, clientHeight: 400 };
    expect(shouldLoadOlder(frame, { hasOlder: true, busy: false, failed: false })).toBe(true);
    expect(shouldLoadOlder(frame, { hasOlder: false, busy: false, failed: false })).toBe(false);
    expect(shouldLoadOlder(frame, { hasOlder: true, busy: true, failed: false })).toBe(false);
    expect(shouldLoadOlder(frame, { hasOlder: true, busy: false, failed: true })).toBe(false);
    expect(shouldLoadOlder({ ...frame, scrollTop: HISTORY_THRESHOLD }, { hasOlder: true, busy: false, failed: false })).toBe(false);
  });
});

describe('阅读位置', () => {
  it('补历史前记住位置，内容变高后按差值还原，不把用户拽回底部', () => {
    const before = { scrollHeight: 800, scrollTop: 120, clientHeight: 400 };
    const anchor = readingAnchor('older', before, true);
    expect(anchor).toEqual({ height: 800, top: 120 });
    expect(resolveAnchorTop(anchor!, 1300)).toBe(620);
  });

  it('轮询到最新内容时，跟随则贴底、不跟随则完全不动', () => {
    const frame = { scrollHeight: 800, scrollTop: 100, clientHeight: 400 };
    expect(readingAnchor('latest', frame, true)).toEqual({ bottom: true });
    expect(resolveAnchorTop({ bottom: true }, 1500)).toBe(1500);
    expect(readingAnchor('latest', frame, false)).toBeNull();
  });

  it('阅读区尚未挂载时退化为跟随语义，不产出位置锚点', () => {
    expect(readingAnchor('older', null, false)).toBeNull();
    expect(readingAnchor('older', null, true)).toEqual({ bottom: true });
  });
});

describe('轮次合并', () => {
  it('按 turnId 去重，older 时旧页排在前面', () => {
    const existing = [turn('b'), turn('c')];
    const incoming = [turn('a'), turn('b')];
    expect(ids(mergeTurns(existing, incoming, 'older'))).toEqual(['a', 'b', 'c']);
    expect(ids(mergeTurns(existing, [turn('d')], 'latest'))).toEqual(['b', 'c', 'd']);
  });

  it('重复轮次：latest 以新到的为准，older 保留已加载的那份', () => {
    const loaded = turn('a', { unavailable: true });
    const fetched = turn('a', { unavailable: false });
    expect(mergeTurns([loaded], [fetched], 'latest')[0]!.unavailable).toBe(false);
    expect(mergeTurns([fetched], [loaded], 'older')[0]!.unavailable).toBe(false);
  });
});

describe('变化判定', () => {
  it('内容相同不算变化：轮询空转不能重置阅读位置', () => {
    const existing = [turn('a', { messages: [{ role: 'user', text: 'hi' }] })];
    expect(turnsChanged(mergeTurns(existing, [turn('a', { messages: [{ role: 'user', text: 'hi' }] })], 'latest'), existing)).toBe(false);
  });

  it('同一轮的消息文本增长算变化，正在写入的会话才能续上', () => {
    const existing = [turn('a', { messages: [{ role: 'assistant', text: 'par' }] })];
    const next = mergeTurns(existing, [turn('a', { messages: [{ role: 'assistant', text: 'partial' }] })], 'latest');
    expect(turnsChanged(next, existing)).toBe(true);
  });

  it('分页大小是具名常量，长会话的翻页成本由它决定', () => {
    expect(READER_PAGE_LIMIT).toBeGreaterThan(0);
  });
});
