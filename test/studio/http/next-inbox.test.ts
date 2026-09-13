import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'vitest';
import { createNextStudioServer } from '../../../src/studio/http/next-server.js';
import { buildObservationInboxReport, saveObservationInboxReport } from '../../../src/observability/inbox/index.js';
import type { ConversationCatalog } from '../../../src/observability/conversation/catalog.js';
import type { ReportServer } from '../../../src/studio/http/contracts.js';

const servers: ReportServer[] = [];
const dirs: string[] = [];

const fixtureTrace = fileURLToPath(new URL('../../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url));

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function observationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omk-next-inbox-'));
  dirs.push(dir);
  return dir;
}

const emptyCatalog: ConversationCatalog = {
  async listConversations() {
    return { conversations: [], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 };
  },
  async getConversation() {
    return undefined;
  },
  async loadTaskTrajectory() {
    return undefined;
  },
};

async function startInboxHost(observationsDirPath: string): Promise<string> {
  const server = createNextStudioServer({
    port: 0,
    observationsDir: observationsDirPath,
    conversationCatalog: emptyCatalog,
  });
  servers.push(server);
  return server.start();
}

describe('Next-hosted observation inbox route', () => {
  it('serves /observe/inbox from the React page', async () => {
    const url = await startInboxHost(observationsDir());
    const response = await fetch(`${url}/observe/inbox`);
    assert.equal(response.status, 200);
    const html = await response.text();
    // Next 产物在场才说明这是 App Router 渲染，而不是回落到别的手写 HTML 宿主。
    assert.match(html, /\/_next\/static\//);
    assert.match(html, /<h1>观测收件箱<\/h1>/);
    assert.match(html, /ant-tabs/);
    for (const tab of ['信号', 'Skill 看板', '体验复盘', '指标', '时间轴', '复核待办', 'Skill 链']) {
      assert.ok(html.includes(tab), `tab ${tab} must be rendered`);
    }
    assert.match(html, /0 条信号（共 0 条）/);
  }, 20000);

  it('honours the lang query parameter', async () => {
    const url = await startInboxHost(observationsDir());
    const html = await (await fetch(`${url}/observe/inbox?lang=en`)).text();
    assert.match(html, /<h1>Observation inbox<\/h1>/);
    assert.match(html, /0 signals \(0 total\)/);
  }, 20000);

  it('rejects non-GET requests', async () => {
    const url = await startInboxHost(observationsDir());
    const response = await fetch(`${url}/observe/inbox`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(await response.text(), 'method_not_allowed');
  }, 20000);

  it('submits and revokes a session review through the API the React page calls', async () => {
    const dir = observationsDir();
    const url = await startInboxHost(dir);
    const endpoint = `${url}/api/observe-inbox/review-state`;
    const key = 'experience_session:session-1';
    const persisted = () => {
      const file = join(dir, 'review-state.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) as { entries: Record<string, unknown> } : { entries: {} };
    };

    const posted = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'experience_session', targetId: 'session-1', verdict: 'real_issue' }),
    });
    assert.equal(posted.status, 200);
    const afterPost = (await posted.json()) as { entries: Record<string, { verdict: string }> };
    assert.equal(afterPost.entries[key]?.verdict, 'real_issue');
    const read = (await (await fetch(endpoint)).json()) as { entries: Record<string, { verdict: string }> };
    assert.equal(read.entries[key]?.verdict, 'real_issue');
    // 落盘才说明刷新页面后 React 仍能看到这条复核，而不是只活在内存里。
    assert.equal(persisted().entries[key] !== undefined, true);

    const revoked = await fetch(`${endpoint}?targetType=experience_session&targetId=session-1`, { method: 'DELETE' });
    assert.equal(revoked.status, 200);
    const afterDelete = (await revoked.json()) as { entries: Record<string, unknown> };
    assert.equal(afterDelete.entries[key], undefined);
    assert.equal(persisted().entries[key], undefined);
  }, 20000);

  it('projects an unreadable observations directory to 503 without leaking the cause', async () => {
    const dir = observationsDir();
    // reports 是文件而不是目录：读取会抛 ENOTDIR，宿主必须收敛成稳定的 503。
    writeFileSync(join(dir, 'reports'), 'not-a-directory secret=/private/token');
    const url = await startInboxHost(dir);
    const response = await fetch(`${url}/observe/inbox`);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'studio_source_unavailable');
  }, 20000);

  it('serves the conversation thread that the review card links to', async () => {
    const dir = observationsDir();
    const report = buildObservationInboxReport(fixtureTrace);
    const session = report.experience!.sessions[0];
    saveObservationInboxReport(report, dir);
    const threadId = session.threadId;
    const catalog: ConversationCatalog = {
      async listConversations() {
        return { conversations: [], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 };
      },
      async getConversation(id) {
        if (id !== threadId) return undefined;
        return {
          threadId,
          sourceThreadId: threadId,
          sourceKind: session.sourceKind,
          title: '深链目标会话',
          relatedSkillNames: [session.skillName],
          tasks: session.turns.map((turn) => ({
            turnId: turn.turnId,
            title: '任务',
            status: 'completed' as const,
            eventCount: 1,
            toolCallCount: 0,
            toolFailureCount: 0,
            relatedSkillNames: [],
          })),
        };
      },
      async loadTaskTrajectory() {
        return undefined;
      },
    };
    const server = createNextStudioServer({ port: 0, observationsDir: dir, conversationCatalog: catalog });
    servers.push(server);
    const url = await server.start();

    // Tabs 只服务端渲染当前面板，深链本身由 inbox-experience-review.test.tsx 锁定；
    // 这里锁的是同一个宿主上收件箱与它的下钻目标都可达。
    assert.equal((await fetch(`${url}/observe/inbox`)).status, 200);
    const thread = await fetch(`${url}/observe/conversations/${encodeURIComponent(threadId)}`);
    assert.equal(thread.status, 200);
    assert.match(await thread.text(), /深链目标会话/);
  }, 30000);
});
