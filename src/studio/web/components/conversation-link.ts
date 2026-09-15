import { OBSERVE_CONVERSATION_PREFIX } from '../../http/page-paths';
import { langSuffix, type Language } from './layout/shell';

/**
 * 对话任务深链的单一 owner。
 *
 * `threadId`／`turnId` 来自外部证据，可以包含 `/` 等路径字符，必须逐段编码：两处各拼一遍时，
 * 一处编码、一处不编码，同一个会话就会在一个页面能打开、在另一个页面 404。
 * 语言由地址决定，静态链接一律显式带上 `lang`（见 `src/studio/README.md`），省略参数等于把
 * 用户本次的选择交回本机全局偏好。
 */
export function conversationPath(threadId: string, turnId?: string): string {
  const task = turnId ? `/tasks/${encodeURIComponent(turnId)}` : '';
  return `${OBSERVE_CONVERSATION_PREFIX}${encodeURIComponent(threadId)}${task}`;
}

export function conversationHref(threadId: string, lang: Language): string {
  return `${conversationPath(threadId)}${langSuffix(lang)}`;
}

export function taskHref(threadId: string, turnId: string, lang: Language): string {
  return `${conversationPath(threadId, turnId)}${langSuffix(lang)}`;
}
