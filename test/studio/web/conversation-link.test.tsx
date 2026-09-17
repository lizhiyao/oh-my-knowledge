import { expect, it } from 'vitest';
import { conversationPath } from '../../../src/studio/web/components/conversation-link.js';

it('encodes every identifier segment so a thread id with a slash still opens', () => {
  expect(conversationPath('thread/a b')).toBe('/observe/conversations/thread%2Fa%20b');
  expect(conversationPath('thread/a', 'turn?b')).toBe('/observe/conversations/thread%2Fa/tasks/turn%3Fb');
});

it('never carries a language parameter, because language comes from local settings', () => {
  expect(conversationPath('thread')).toBe('/observe/conversations/thread');
});

it('omits the task segment only when there is no turn to return to', () => {
  expect(conversationPath('thread', 'turn')).toBe('/observe/conversations/thread/tasks/turn');
  expect(conversationPath('thread', undefined)).toBe('/observe/conversations/thread');
});
