/**
 * Next 宿主上的 /agents 路由：证明第 4 项交付的是真实页面，而不是一组还没接线的模块。
 *
 * 断言只看用户可读的东西：标题、识别到的产品名、被截断与未识别计数的告警、缺报告时给出的
 * 下一步命令。这些正是「GUI 呈现了 omk agents 的产物」的可证伪证据；换成断言 DOM 结构，
 * 页面改一版样式就变红，却证明不了任何事实。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { agentStorageLayout, saveAgentCollectionReport, saveAgentInventoryReport } from '../../../src/observability/agents/index.js';
import { createNextStudioServer } from '../../../src/studio/http/next-server.js';
import type { ConversationCatalog } from '../../../src/observability/conversation/catalog.js';
import type { ReportServer } from '../../../src/studio/http/contracts.js';
import { sampleCollectionReport, sampleInventoryReport } from '../_agents-report-fixtures.js';

const servers: ReportServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

async function startAgentsHost(agentsDir: string, extra: Record<string, unknown> = {}): Promise<string> {
  const server = createNextStudioServer({
    port: 0, agentsDir, conversationCatalog: emptyCatalog, ...extra,
  });
  servers.push(server);
  return server.start();
}

function agentsDirWith(write: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'omk-next-agents-'));
  dirs.push(dir);
  write(dir);
  return dir;
}

describe('Next 宿主的 /agents 路由', () => {
  it('渲染识别结果与采集记录，并把截断与未识别计数标出来', async () => {
    const url = await startAgentsHost(agentsDirWith((dir) => {
      saveAgentInventoryReport(sampleInventoryReport(), agentStorageLayout(dir));
      saveAgentCollectionReport(sampleCollectionReport(), dir);
    }));
    const response = await fetch(`${url}/agents`);
    assert.equal(response.status, 200);
    const html = await response.text();
    // Next 产物在场才说明这是 App Router 渲染，而不是回落到别的手写 HTML 宿主。
    assert.match(html, /\/_next\/static\//);
    assert.match(html, /<h1>本机 Agent<\/h1>/);
    assert.match(html, /<title>OMK · 本机 Agent<\/title>/);
    for (const fact of ['Codex', 'Cursor', 'OpenClaw', '/opt/homebrew/bin/codex', 'traces/codex/trace-1.json', '修复登录态丢失']) {
      assert.ok(html.includes(fact), `页面缺少事实：${fact}`);
    }
    // 计数被容量上限砍过、事件没被识别，都必须显式出现在页面上而不是被静默汇总。
    assert.match(html, /登记表 3 个 · 已安装 2 个 · 会话日志 42 份/);
    assert.match(html, /有日志根被容量上限截断/);
    assert.match(html, /25 \/ 100/);
    assert.match(html, /本轮采集上限为 200 个会话文件/);
    // 一级导航给出入口并标出当前区。
    assert.match(html, /<a[^>]*aria-current="page"[^>]*href="\/agents"/);
  }, 30000);

  it('还没跑过命令时给出下一步命令，而不是空页或错误码', async () => {
    const url = await startAgentsHost(agentsDirWith(() => {}));
    const response = await fetch(`${url}/agents`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /还没有识别过本机 Agent/);
    assert.match(html, /还没有采集过日志/);
    assert.match(html, /omk agents collect/);
    // 没有报告就没有表格数据：呈现空列表会被读成「本机没装任何 Agent」。
    assert.doesNotMatch(html, /登记表 0 个/);
  }, 30000);

  it('报告读不动时说明读不动，不拿缺文件顶替', async () => {
    const url = await startAgentsHost(agentsDirWith((dir) => {
      saveAgentCollectionReport(sampleCollectionReport(), dir);
      writeFileSync(join(dir, 'inventory.json'), '{"schemaVersion":"agent-inventory-v1"');
    }));
    const html = await (await fetch(`${url}/agents`)).text();
    assert.match(html, /识别报告读不动/);
    // 坏一份不影响另一份：采集结果照常呈现，用户才分得清哪一步出了问题。
    assert.match(html, /采集 2 份会话/);
  }, 30000);

  it('只接受 GET', async () => {
    const url = await startAgentsHost(agentsDirWith(() => {}));
    const response = await fetch(`${url}/agents`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(await response.text(), 'method_not_allowed');
  }, 30000);

  it('宿主裁掉 Studio 页面组时不接管 /agents，也不渲染指向它的导航', async () => {
    const url = await startAgentsHost(agentsDirWith(() => {}), {
      studioPages: false,
      coreStudioCatalog: { async list() { return []; }, async get() { return undefined; }, async inspect() { return undefined; } },
    });
    assert.equal((await fetch(`${url}/agents`, { redirect: 'manual' })).status, 404);
    const html = await (await fetch(`${url}/measure`)).text();
    assert.doesNotMatch(html, /href="\/agents/);
  }, 30000);
});
