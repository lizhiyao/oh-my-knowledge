import { describe, expect, it } from 'vitest';
import type { ConversationReaderPage } from '../../../src/studio/view-models/conversations/conversation-reader.js';
import { failureAction, readerState, turnFallback } from '../../../src/studio/application/conversations/reader-states.js';

type Turn = ConversationReaderPage['turns'][number];
const turn = (extra: Partial<Turn> = {}): Turn => ({ task: { turnId: 'a' } as Turn['task'], messages: [], unavailable: false, ...extra });

describe('阅读区呈现状态', () => {
  it('首次进入是加载中，读完没内容才是空', () => {
    expect(readerState({ loaded: false, failed: false, turnCount: 0 })).toBe('loading');
    expect(readerState({ loaded: true, failed: false, turnCount: 0 })).toBe('empty');
    expect(readerState({ loaded: true, failed: false, turnCount: 3 })).toBe('reading');
  });

  it('失败时不让空状态和失败提示同时出现', () => {
    expect(readerState({ loaded: false, failed: true, turnCount: 0 })).toBe('reading');
    expect(readerState({ loaded: true, failed: true, turnCount: 0 })).toBe('reading');
    expect(readerState({ loaded: true, failed: true, turnCount: 2 })).toBe('reading');
  });
});

describe('失败后的动作', () => {
  it('游标失效要整段重读，普通失败只重试上一次请求', () => {
    expect(failureAction(true)).toBe('reload');
    expect(failureAction(false)).toBe('retry');
  });
});

describe('单轮退路', () => {
  it('读不出原始记录、有消息、没消息是三种不同处境', () => {
    expect(turnFallback(turn({ unavailable: true }))).toBe('unreadable');
    expect(turnFallback(turn({ unavailable: true, messages: [{ role: 'user', text: 'x' }] }))).toBe('unreadable');
    expect(turnFallback(turn({ messages: [{ role: 'user', text: 'x' }] }))).toBe('messages');
    expect(turnFallback(turn())).toBe('no-messages');
  });
});
