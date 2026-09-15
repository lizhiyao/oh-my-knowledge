import type { ConversationReaderPage } from '../../view-models/conversations/conversation-reader.js';

type Turn = ConversationReaderPage['turns'][number];

/** 阅读区的呈现状态。失败时即使一轮都没读到也不显示空状态，否则会和失败提示抢同一句话。 */
export type ReaderState = 'loading' | 'empty' | 'reading';

export function readerState(state: { loaded: boolean; failed: boolean; turnCount: number }): ReaderState {
  if (!state.loaded && !state.failed) return 'loading';
  if (state.turnCount === 0 && !state.failed) return 'empty';
  return 'reading';
}

/** 游标失效（409）意味着已加载的窗口对不上来源，只能整段重读；普通失败重试上一次请求即可。 */
export function failureAction(resetRequired: boolean): 'reload' | 'retry' {
  return resetRequired ? 'reload' : 'retry';
}

/** 单轮的退路：原始记录读不出来时仍可去执行详情看剩余证据，没有消息则只是这一轮没说话。 */
export function turnFallback(turn: Turn): 'unreadable' | 'messages' | 'no-messages' {
  if (turn.unavailable) return 'unreadable';
  return turn.messages.length ? 'messages' : 'no-messages';
}
