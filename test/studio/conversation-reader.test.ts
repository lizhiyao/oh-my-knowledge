import { expect, it } from 'vitest';
import type { ConversationCatalog } from '../../src/observability/conversation/catalog.js';
import { readConversationTurns } from '../../src/studio/application/conversation-reader.js';

it('pages newest turns, isolates unavailable turns and returns only readable human/assistant text', async () => {
  const tasks = ['old', 'broken', 'new'].map(turnId => ({ turnId, title: turnId, status: 'completed' as const, eventCount: 1, toolCallCount: 0, toolFailureCount: 0, relatedSkillNames: [] }));
  const calls: string[] = [];
  const catalog: ConversationCatalog = {
    async listConversations() { throw new Error('unused'); },
    async getConversation(id) { return id === 'thread' ? { threadId: id, sourceThreadId: id, sourceKind: 'codex', title: 'Reader', tasks, relatedSkillNames: [] } : undefined; },
    async loadTaskTrajectory() { throw new Error('unused'); },
    async loadTaskMessageRecords(_id, turn) {
      calls.push(turn);
      if (turn === 'broken') throw new Error('private-secret');
      return { path: '/private/log', records: [
        { recordIndex: 1, raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Question ${turn}` }] } }) },
        { recordIndex: 2, raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Full answer' }] } }) },
        { recordIndex: 3, raw: JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool', output: 'private-tool-output' } }) },
      ] };
    },
  };
  const first = await readConversationTurns(catalog, 'thread', 0, 2);
  expect(first?.total).toBe(3);
  expect(first?.turns.map(turn => turn.task.turnId)).toEqual(['new', 'broken']);
  expect(first?.turns[0].messages.map(message => message.text)).toEqual(['Question new', 'Full answer']);
  expect(first?.turns[1].unavailable).toBe(true);
  expect(JSON.stringify(first)).not.toMatch(/private-secret|private-tool-output|\/private\/log/);
  expect(calls).toEqual(['new', 'broken']);
  expect((await readConversationTurns(catalog, 'thread', 2, 2))?.turns[0].task.turnId).toBe('old');
  expect(await readConversationTurns(catalog, 'missing', 0, 2)).toBeUndefined();
});
