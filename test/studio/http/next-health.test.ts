import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { writeMeasurementReportBundle } from '../../../src/evidence/storage/report-bundle.js';
import { computeSkillHealthFromSegments } from '../../../src/observability/skill-health/analyzer.js';
import type { SkillSegment } from '../../../src/observability/trace/index.js';
import type { ConversationCatalog } from '../../../src/observability/conversation/catalog.js';
import { createNextStudioServer } from '../../../src/studio/http/next-server.js';
import type { ReportServer, ReportServerOptions } from '../../../src/studio/http/contracts.js';

const servers: ReportServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function segmentOf(skillName: string, segmentIndex: number, over: { calls?: number; failures?: number } = {}): SkillSegment {
  return {
    skillName,
    sessionId: 'session-1',
    segmentIndex,
    startTimestamp: '2026-09-01T00:00:00Z',
    endTimestamp: '2026-09-01T00:10:00Z',
    turns: [],
    toolCalls: [],
    metrics: {
      durationMs: 600_000,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      numTurns: 0,
      numToolCalls: over.calls ?? 0,
      numToolFailures: over.failures ?? 0,
      numToolUnknown: 0,
      tokenUsageObserved: false,
    },
  };
}

/** 走真实产出函数造报告，再按存储契约落盘：页面因此测的是「observe 产物 → 路由 → React」整条链。 */
function writeReport(options: { root: string; recordId: string; generatedAt: string; segments: SkillSegment[] }): void {
  const report = computeSkillHealthFromSegments(options.segments, [], join(options.root, 'trace.jsonl'));
  const stamped = { ...report, meta: { ...report.meta, generatedAt: options.generatedAt } };
  writeMeasurementReportBundle({
    rootDir: options.root,
    recordId: options.recordId,
    reportId: options.recordId,
    measurementDomain: 'observe-health',
    createdAt: options.generatedAt,
    report: stamped,
  });
}

const HOSTILE = '<script>alert(1)</script>';

const emptyCatalog: ConversationCatalog = {
  async listConversations() {
    return { conversations: [], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 };
  },
  async getConversation() { return undefined; },
  async loadTaskTrajectory() { return undefined; },
};

async function serve(options: Omit<ReportServerOptions, 'port'>): Promise<string> {
  const server = createNextStudioServer({ port: 0, conversationCatalog: emptyCatalog, ...options });
  servers.push(server);
  return server.start();
}

/** React 在相邻动态文本之间插 `<!-- -->` 定界；剥掉注释后才能按可见顺序断言。 */
async function htmlOf(response: Response): Promise<string> {
  return (await response.text()).replaceAll('<!-- -->', '');
}

describe('Next 宿主的观测健康页面组', () => {
  it('列表、详情、趋势、差异四页读同一份 observe 产物，并守住状态码契约', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-next-health-')); roots.push(root);
    const analysesDir = join(root, 'analyses');
    writeReport({
      root: analysesDir,
      recordId: 'obs-a',
      generatedAt: '2026-09-01T08:30:00Z',
      segments: [
        ...Array.from({ length: 6 }, (_, i) => segmentOf('audit', i, { calls: i < 4 ? 1 : 0, failures: i < 2 ? 1 : 0 })),
        segmentOf(HOSTILE, 6, { calls: 1 }),
      ],
    });
    writeReport({
      root: analysesDir,
      recordId: 'obs-b',
      generatedAt: '2026-09-02T08:30:00Z',
      segments: Array.from({ length: 6 }, (_, i) => segmentOf('audit', i)),
    });
    const url = await serve({ analysesDir, doctorsDir: join(root, 'doctors'), observationsDir: join(root, 'observations') });

    const list = await fetch(`${url}/observe/health`);
    assert.equal(list.status, 200);
    assert.match(list.headers.get('cache-control') ?? '', /no-store/);
    const listHtml = await htmlOf(list);
    // 分区导航必须标出当前页，否则健康度页与会话页在界面上断开。
    assert.match(listHtml, /aria-current="page" href="\/observe\/health"/);
    for (const id of ['obs-a', 'obs-b']) assert.ok(listHtml.includes(`href="/observe/health/${id}"`), `${id} 没有入口`);
    assert.ok(listHtml.includes('2026-09-02 08:30'), '列表按生成时间展示，最新在前');
    assert.doesNotMatch(listHtml, /<script>alert/, '报告里的外部文本不能成为标记');

    const enList = await fetch(`${url}/observe/health?lang=en`);
    assert.equal(enList.status, 200);
    assert.match(await htmlOf(enList), /Pick from\/to on two reports/);

    const detail = await fetch(`${url}/observe/health/obs-a`);
    assert.equal(detail.status, 200);
    const detailHtml = await htmlOf(detail);
    assert.match(detailHtml, /各 skill 健康度/);
    assert.match(detailHtml, /2\/4 失败（50%）/, '工具失败读数与 CLI 同口径');
    assert.ok(detailHtml.includes('href="/observe"'), '详情页面包屑回观测');
    assert.match(detailHtml, /&lt;script&gt;alert/, 'skill 名以转义文本可见，而不是被静默丢弃');
    assert.doesNotMatch(detailHtml, /<script>alert/);

    const trend = await fetch(`${url}/observe/skill-trend/audit`);
    assert.equal(trend.status, 200);
    const trendHtml = await htmlOf(trend);
    assert.match(trendHtml, /2 个时间点/);
    assert.ok(trendHtml.includes('href="/observe/health/obs-a"'), '每个时间点链回它的报告');
    const emptyTrend = await fetch(`${url}/observe/skill-trend/never-seen`);
    assert.equal(emptyTrend.status, 200);
    assert.match(await htmlOf(emptyTrend), /暂无趋势数据/);

    const diff = await fetch(`${url}/observe/health-diff?from=obs-a&to=obs-b`);
    assert.equal(diff.status, 200);
    const diffHtml = await htmlOf(diff);
    assert.match(diffHtml, /Skill 健康度对比/);
    assert.match(diffHtml, /已消失/, '只在起点出现的 skill 要标出来');

    // 契约：缺参是请求错，查不到是缺页，且都不带重定向。
    const noParams = await fetch(`${url}/observe/health-diff?from=obs-a`);
    assert.equal(noParams.status, 400);
    assert.equal(await noParams.text(), 'missing from/to query params');
    for (const path of ['/observe/health-diff?from=obs-a&to=ghost', '/observe/health/ghost', '/observe/health/%ZZ', '/observe/health/', '/observe/health/obs-a%2Fghost']) {
      const missing = await fetch(`${url}${path}`, { redirect: 'manual' });
      assert.equal(missing.status, 404, `${path} 应缺页`);
      assert.equal(missing.headers.get('location'), null, `${path} 不留重定向`);
      assert.equal(await missing.text(), 'analysis not found');
    }

    const post = await fetch(`${url}/observe/health`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
  }, 30000);

  it('会话页给出健康度入口，收件箱开关不影响健康页可达', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-next-health-nav-')); roots.push(root);
    const analysesDir = join(root, 'analyses');
    writeReport({ root: analysesDir, recordId: 'obs-a', generatedAt: '2026-09-01T08:30:00Z', segments: [segmentOf('audit', 0)] });
    const url = await serve({
      analysesDir,
      doctorsDir: join(root, 'doctors'),
      observationsDir: join(root, 'observations'),
      observationInbox: false,
    });
    const observe = await fetch(`${url}/observe`);
    assert.equal(observe.status, 200);
    assert.match(await observe.text(), /aria-current="page" href="\/observe"/);

    // 健康页只挂在 studioPages 上：DSH 这类裁掉收件箱的宿主仍要能看，否则迁移等于把页面弄丢。
    assert.equal((await fetch(`${url}/observe/health`)).status, 200);
    assert.equal((await fetch(`${url}/observe/inbox`)).status, 404);
  }, 30000);
});
