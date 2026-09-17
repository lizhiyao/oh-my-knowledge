import { OBSERVE_CONVERSATION_PREFIX } from '../../http/page-paths';

/**
 * 对话任务深链的单一 owner。
 *
 * `threadId`／`turnId` 来自外部证据，可以包含 `/` 等路径字符，必须逐段编码：两处各拼一遍时，
 * 一处编码、一处不编码，同一个会话就会在一个页面能打开、在另一个页面 404。
 * 语言不进地址：渲染语言只看本机设置（见 `src/studio/README.md`）。
 */
export function conversationPath(threadId: string, turnId?: string): string {
  const task = turnId ? `/tasks/${encodeURIComponent(turnId)}` : '';
  return `${OBSERVE_CONVERSATION_PREFIX}${encodeURIComponent(threadId)}${task}`;
}
