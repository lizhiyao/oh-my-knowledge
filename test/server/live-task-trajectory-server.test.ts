import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { buildObservationInboxReport } from '../../src/observability/inbox.js';
import type {
  ConversationCatalog,
  ConversationTaskTrajectory,
} from '../../src/observability/conversation-catalog.js';
import { createReportServer } from '../../src/server/report-server.js';

describe('Live task trajectory server', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-live-trajectory-server-'));
  const tracePath = join(root, 'rollout.jsonl');
  let server: ReturnType<typeof createReportServer> | undefined;
  let baseUrl = '';
  let trajectory: ConversationTaskTrajectory;
  let unsubscribed = false;
  let cancelledBeforeReady = false;

  beforeAll(async () => {
    mkdirSync(join(root, 'reports'), { recursive: true });
    mkdirSync(join(root, 'jobs'), { recursive: true });
    const fixture = readFileSync(new URL('../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line && !line.includes('"type":"task_complete"'))
      .join('\n');
    const pendingToolCall = JSON.stringify({
      timestamp: '2026-08-03T00:00:08.500Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'live-pending',
        name: 'exec_command',
        input: '{"cmd":"yarn test"}',
      },
    });
    writeFileSync(tracePath, `${fixture}\n${pendingToolCall}\n`);
    const report = buildObservationInboxReport(tracePath);
    const session = report.experience?.sessions[0];
    assert.ok(session);
    assert.ok(report.meta.ingestion);
    trajectory = {
      revision: 'revision-1',
      status: 'open',
      liveObservable: true,
      session,
      ingestion: report.meta.ingestion,
      sourceRecords: {
        status: 'available',
        recordCount: 0,
        records: [],
        omittedRecordCount: 0,
        byteCount: 0,
        truncated: false,
      },
    };
    const catalog: ConversationCatalog = {
      async listConversations() {
        return { conversations: [], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 };
      },
      async getConversation() {
        return undefined;
      },
      async loadTaskTrajectory() {
        return trajectory;
      },
      async observeTaskTrajectory(_threadId, turnId, observer, options) {
        if (turnId === 'error') {
          observer.error?.(new Error('实时轨迹读取失败'));
          return () => { unsubscribed = true; };
        }
        if (turnId === 'pending') {
          return new Promise<() => void>((_resolve, reject) => {
            const abort = () => {
              cancelledBeforeReady = true;
              const error = new Error('cancelled');
              error.name = 'AbortError';
              reject(error);
            };
            if (options?.signal?.aborted) abort();
            else options?.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        observer.next(trajectory);
        return () => { unsubscribed = true; };
      },
    };
    server = createReportServer({
      port: 0,
      reportsDir: join(root, 'reports'),
      jobsDir: join(root, 'jobs'),
      observationsDir: join(root, 'observations'),
      conversationCatalog: catalog,
    });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('marks an open task as live and exposes a lightweight SSE revision stream', async () => {
    const threadId = trajectory.session.threadId;
    const turnId = trajectory.session.turns[0]!.turnId;
    const page = await fetch(`${baseUrl}/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(turnId)}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /data-live-revision="revision-1"/);
    assert.match(html, /class="trajectory-live-state"/);
    assert.match(html, /data-live-follow/);
    assert.match(html, />跟随中</);
    assert.match(html, /createTrajectoryLiveController/);
    assert.match(html, /refreshTrajectorySnapshot/);
    assert.match(html, /new DOMParser\(\)/);
    assert.match(html, /shell\.replaceWith\(replacement\)/);
    assert.match(html, /is-live-entering/);
    assert.match(html, /结果获取中/);
    assert.match(html, /trajectory-event is-pending/);
    assert.doesNotMatch(html, /结果缺失/);

    const event = await readFirstEvent(
      `${baseUrl}/api/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(turnId)}/live`,
    );
    assert.match(event, /event: trajectory/);
    assert.match(event, /"revision":"revision-1"/);
    assert.match(event, /"status":"open"/);
    assert.match(event, /"liveObservable":true/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(unsubscribed, true);
  });

  it('uses a terminal application event when live polling fails', async () => {
    const event = await readFirstEvent(
      `${baseUrl}/api/conversations/thread/tasks/error/live`,
    );
    assert.match(event, /event: trajectory-error/);
    assert.match(event, /"error":"实时轨迹读取失败"/);
  });

  it('cancels live initialization when the client disconnects before the first snapshot', async () => {
    await connectThenClose(
      `${baseUrl}/api/conversations/thread/tasks/pending/live`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelledBeforeReady, true);
  });
});

function connectThenClose(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      headers: { Accept: 'text/event-stream' },
    }, () => {
      request.destroy();
      resolve();
    });
    request.on('error', (cause) => reject(cause));
  });
}

function readFirstEvent(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    let settled = false;
    const request = http.get({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      headers: { Accept: 'text/event-stream' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (!settled && body.includes('\n\n')) {
          settled = true;
          resolve(body);
          request.destroy();
        }
      });
    });
    request.on('error', (cause) => {
      if (!settled) reject(cause);
    });
  });
}
