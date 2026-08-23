import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildDshHostResult } from '../../src/executors/dsh-protocol.js';

describe('DSH event projection', () => {
  it('preserves host-observed order across root, tool, and subagent events', () => {
    const result = buildDshHostResult({
      rootSessionId: 'root',
      finalResponse: 'root answer',
      childSessionIds: ['child'],
      events: [
        {
          sessionId: 'root',
          traceRole: 'main',
          event: {
            type: 'user/message',
            data: { message: { content: [{ type: 'text', text: 'question' }] } },
          },
        },
        {
          sessionId: 'root',
          traceRole: 'main',
          event: {
            type: 'tool/call',
            data: { callId: 'call-1', name: 'read', arguments: '{}' },
          },
        },
        {
          sessionId: 'child',
          traceRole: 'subagent',
          event: {
            type: 'assistant/message',
            data: {
              message: { content: [{ type: 'text', text: 'child answer' }] },
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          },
        },
        {
          sessionId: 'root',
          traceRole: 'main',
          event: {
            type: 'tool/result',
            data: {
              message: {
                content: [{
                  type: 'tool-result',
                  toolCallId: 'call-1',
                  content: [{ type: 'text', text: 'file contents' }],
                }],
              },
            },
          },
        },
        {
          sessionId: 'root',
          traceRole: 'main',
          event: {
            type: 'assistant/message',
            data: {
              message: { content: [{ type: 'text', text: 'root answer' }] },
              usage: { inputTokens: 2, outputTokens: 2 },
            },
          },
        },
        {
          sessionId: 'root',
          traceRole: 'main',
          event: { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        },
      ],
    }, 10);

    assert.deepEqual(result.turns?.map((turn) => [turn.role, turn.content]), [
      ['user', 'question'],
      ['tool', 'file contents'],
      ['assistant', 'child answer'],
      ['assistant', 'root answer'],
    ]);
    assert.equal(result.toolCalls?.[0]?.traceRole, 'main');
    assert.equal(result.numSubAgents, 1);
  });
});
