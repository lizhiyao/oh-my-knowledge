import { expect, it } from 'vitest';
import { conversationHref, conversationPath, taskHref } from '../../../src/studio/web/components/conversation-link.js';

it('encodes every identifier segment so a thread id with a slash still opens', () => {
  expect(conversationHref('thread/a b', 'zh')).toBe('/observe/conversations/thread%2Fa%20b?lang=zh');
  expect(taskHref('thread/a', 'turn?b', 'en')).toBe('/observe/conversations/thread%2Fa/tasks/turn%3Fb?lang=en');
});

it('always carries an explicit language, because a bare address follows the local preference', () => {
  expect(conversationHref('thread', 'en')).toBe('/observe/conversations/thread?lang=en');
  expect(conversationPath('thread')).toBe('/observe/conversations/thread');
});

it('omits the task segment only when there is no turn to return to', () => {
  expect(conversationPath('thread', 'turn')).toBe('/observe/conversations/thread/tasks/turn');
  expect(conversationPath('thread', undefined)).toBe('/observe/conversations/thread');
});
