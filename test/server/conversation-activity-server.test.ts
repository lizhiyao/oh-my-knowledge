import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { ConversationCatalog } from '../../src/observability/conversation-catalog.js';
import { createReportServer } from '../../src/server/report-server.js';
import type { ConversationListItem } from '../../src/observability/view-models/conversation.js';

describe('Conversation activity server', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-conversation-activity-'));
  const threadId = 'thread/activity';
  let server: ReturnType<typeof createReportServer> | undefined;
  let baseUrl = '';
  let conversation: ConversationListItem = {
    threadId,
    sourceThreadId: threadId,
    sourceKind: 'codex',
    title: '进行中的对话',
    archived: false,
    turnCount: 1,
    toolCallCount: 0,
    toolFailureCount: 0,
    relatedSkillNames: [],
    tasks: [{
      turnId: 'turn-1',
      title: '当前任务',
      status: 'open',
      startTimestamp: '2026-08-10T00:00:00.000Z',
      eventCount: 2,
      toolCallCount: 0,
      toolFailureCount: 0,
      relatedSkillNames: [],
    }],
  };

  beforeAll(async () => {
    for (const directory of ['reports', 'jobs', 'observations']) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    const catalog: ConversationCatalog = {
      async listConversations() {
        return {
          conversations: [conversation],
          totalTurnCount: conversation.turnCount ?? 0,
          totalToolCallCount: conversation.toolCallCount ?? 0,
          totalToolFailureCount: conversation.toolFailureCount ?? 0,
        };
      },
      async getConversation(id) {
        return id === threadId ? conversation : undefined;
      },
      async loadTaskTrajectory() {
        return undefined;
      },
    };
    server = createReportServer({
      port: 0,
      observationsDir: join(root, 'observations'),
      conversationCatalog: catalog,
    });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports task lifecycle changes for one conversation without tracking event growth', async () => {
    const endpoint = `${baseUrl}/api/conversations/${encodeURIComponent(threadId)}/activity`;
    const initialResponse = await fetch(endpoint);
    const initial = await initialResponse.json() as Record<string, unknown>;

    assert.equal(initialResponse.status, 200);
    assert.equal(initialResponse.headers.get('cache-control'), 'no-store');
    assert.equal(initial.taskCount, 1);
    assert.equal(initial.runningCount, 1);
    assert.match(String(initial.revision), /^[a-f0-9]{24}$/u);

    conversation = {
      ...conversation,
      tasks: conversation.tasks.map((task) => ({ ...task, eventCount: 20, toolCallCount: 4 })),
    };
    const eventGrowth = await (await fetch(endpoint)).json() as Record<string, unknown>;
    assert.equal(eventGrowth.revision, initial.revision);

    conversation = {
      ...conversation,
      tasks: conversation.tasks.map((task) => ({
        ...task,
        status: 'completed' as const,
        endTimestamp: '2026-08-10T00:01:00.000Z',
      })),
    };
    const completed = await (await fetch(endpoint)).json() as Record<string, unknown>;
    assert.notEqual(completed.revision, initial.revision);
    assert.equal(completed.runningCount, 0);
  });

  it('prevents the conversation detail page from being restored from stale cache', async () => {
    const response = await fetch(`${baseUrl}/conversations/${encodeURIComponent(threadId)}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /data-activity-endpoint="\/api\/conversations\/thread%2Factivity\/activity"/u);
  });

  it('returns 404 for an unknown conversation', async () => {
    const response = await fetch(`${baseUrl}/api/conversations/missing/activity`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'conversation_not_found' });
  });
});
