/**
 * 受管两页（列表 + 决策史）在 Next 宿主的接线。
 *
 * 页面投影与文案分支由 web/managed-react.test.tsx 锁；这里只锁宿主这一层：路径归 Next 渲染、
 * 语言与导航、缺记录 / 畸形 id / 非 GET / 源不可读的落点，以及受管根「按请求解析、只服务受管请求」。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { managedRecordId, upsertManagedRecord } from '../../../src/knowledge-artifacts/governance/index.js';
import type { ManagedArtifactRecord } from '../../../src/knowledge-artifacts/governance/contracts.js';
import { createNextStudioServer } from '../../../src/studio/http/next-server.js';
import type { ReportServer } from '../../../src/studio/http/contracts.js';
import { coreManagedEvidence } from '../../helpers/core-managed-evidence.js';

const servers: ReportServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const CONTENT_HASH = 'hashV2contenthashlong';

/** git 源带 url：probe 直接按当前 contentHash 判可达，宿主测试不必造真实仓库。 */
function managedRecord(overrides: Partial<ManagedArtifactRecord> = {}): ManagedArtifactRecord {
  return {
    recordKind: 'managed-artifact',
    schemaVersion: 3,
    id: managedRecordId('skill', 'review'),
    name: 'review',
    kind: 'skill',
    source: { sourceKind: 'git', locator: 'git+https://example.com/r@abc123:review', url: 'https://example.com/r', ref: 'abc123', isDirectorySkill: true },
    contentHash: CONTENT_HASH,
    installedAt: '2026-03-01T00:00:00.000Z',
    distribution: [],
    evidence: [coreManagedEvidence(CONTENT_HASH, { runId: 'core-run-1', reportId: 'core-run-1.report', recordedAt: '2026-03-05T00:00:00.000Z' })],
    decisions: [{
      decisionKind: 'promote',
      actor: 'alice',
      decidedAt: '2026-03-06T00:00:00.000Z',
      contentHash: CONTENT_HASH,
      runId: 'core-run-1',
      reason: '已人工复核',
    }],
    ...overrides,
  };
}

function managedDirWith(...records: ManagedArtifactRecord[]): string {
  const dir = tempDir('omk-next-managed-');
  for (const record of records) upsertManagedRecord(dir, record);
  return dir;
}

function startHost(options: { managedDir?: string | (() => string); studioPages?: boolean } = {}): Promise<string> {
  const root = tempDir('omk-next-managed-root-');
  const server = createNextStudioServer({
    port: 0,
    analysesDir: join(root, 'analyses'),
    doctorsDir: join(root, 'doctors'),
    observationsDir: join(root, 'observations'),
    ...options,
  });
  servers.push(server);
  return server.start();
}

/** 命中失败时只打印要找的结构块，不打印整页 antd 内联样式。 */
function section(html: string, pattern: RegExp, label: string): string {
  const found = pattern.exec(html)?.[0];
  assert.ok(found, `missing ${label}`);
  return found ?? '';
}

const TIMELINE = /<ol[^>]*class="[^"]*managed-timeline[\s\S]*?<\/ol>/u;

function assertAbsent(html: string, pattern: RegExp, label: string): void {
  assert.equal(pattern.test(html), false, `${label} 不应出现在页面里`);
}

describe('Next-hosted managed decision history', () => {
  it('renders the managed list from the React page with its section nav', async () => {
    const url = await startHost({ managedDir: managedDirWith(managedRecord()) });
    const response = await fetch(`${url}/knowledge/managed`);
    assert.equal(response.status, 200);
    const html = await response.text();
    // Next 产物在场才说明这是 App Router 渲染，而不是回落到某个手写 HTML 出口。
    assert.match(html, /\/_next\/static\//);
    assert.match(section(html, /<h1>[\s\S]*?<\/h1>/u, 'page heading'), /受管 skill 决策史/);

    const body = section(html, /<tbody[\s\S]*?<\/tbody>/u, 'managed table body');
    assert.match(body, /href="\/knowledge\/managed\/[0-9a-f]{12}"[^>]*>review</);
    assert.match(body, /已采用/);
    assert.match(body, /https:\/\/example\.com\/r/);

    // 分区导航标出本页，知识对象页仍可达 —— 这两页此前没有任何一级入口。
    const nav = section(html, /<nav class="observe-section-nav"[\s\S]*?<\/nav>/u, 'knowledge section nav');
    assert.match(nav, /aria-current="page" href="\/knowledge\/managed"/);
    assert.match(nav, /href="\/knowledge"/);
  }, 20000);

  it('honours the lang query parameter on both pages', async () => {
    const record = managedRecord();
    const url = await startHost({ managedDir: managedDirWith(record) });
    const list = await (await fetch(`${url}/knowledge/managed?lang=en`)).text();
    assert.match(section(list, /<h1>[\s\S]*?<\/h1>/u, 'page heading'), /Managed skill decision history/);
    // 页内跳转必须继承 lang，否则点一次详情就掉回默认中文。
    assert.match(
      section(list, /<tbody[\s\S]*?<\/tbody>/u, 'managed table body'),
      /href="\/knowledge\/managed\/[0-9a-f]{12}\?lang=en"/,
    );
    const detail = await (await fetch(`${url}/knowledge/managed/${record.id}?lang=en`)).text();
    const backLink = section(detail, /<a[^>]*>← Managed skills<\/a>/u, 'back link');
    assert.match(backLink, /href="\/knowledge\/managed\?lang=en"/);
    assert.match(section(detail, TIMELINE, 'decision timeline'), /Promote/);
  }, 20000);

  it('renders the decision timeline and links evidence to the Core run, not the report id', async () => {
    const record = managedRecord();
    const url = await startHost({ managedDir: managedDirWith(record) });
    const response = await fetch(`${url}/knowledge/managed/${record.id}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /\/_next\/static\//);
    assert.match(section(html, /<h1[^>]*>[\s\S]*?<\/h1>/u, 'page heading'), />review</);
    const timeline = section(html, TIMELINE, 'decision timeline');
    assert.match(timeline, /安装纳管/);
    assert.match(timeline, /已人工复核/);
    assert.match(timeline, /决定人 alice/);
    assert.match(timeline, /href="\/measure\/core-run-1"/);
    assertAbsent(html, /\/measure\/core-run-1\.report/, 'Core reportId');
    // 记录里的 source.locator / url 是用户机器与远端的定位符，页面模型不带它们，故不进 RSC 负载。
    assertAbsent(html, /git\+https:\/\/example\.com\/r@abc123/, 'source locator');
    assertAbsent(html, /https:\/\/example\.com\/r/, 'source url');
  }, 20000);

  it('resolves the managed root per request and only for managed requests', async () => {
    const dir = managedDirWith(managedRecord());
    let resolutions = 0;
    const url = await startHost({ managedDir: () => { resolutions += 1; return dir; } });

    assert.equal((await fetch(`${url}/knowledge`)).status, 200);
    assert.equal(resolutions, 0, '知识页不读受管目录');

    assert.equal((await fetch(`${url}/knowledge/managed`)).status, 200);
    assert.equal(resolutions, 1);
    assert.equal((await fetch(`${url}/knowledge/managed`)).status, 200);
    assert.equal(resolutions, 2, '长会话里项目↔全局权威目录会变化，冻结根目录会跟 omk list 分叉');
  }, 20000);

  it('keeps serving /api/managed as the machine-readable source beside the page', async () => {
    const url = await startHost({ managedDir: managedDirWith(managedRecord()) });
    const api = await (await fetch(`${url}/api/managed`)).json() as { rows: { name: string }[] };
    assert.equal(api.rows.find((row) => row.name === 'review') !== undefined, true);
  }, 20000);

  it('answers unknown ids, malformed segments and non-GET without rendering a page', async () => {
    const url = await startHost({ managedDir: managedDirWith(managedRecord()) });
    const missing = await fetch(`${url}/knowledge/managed/abcdef123456`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), 'managed_not_found');
    for (const path of ['/knowledge/managed/', '/knowledge/managed/%ZZ', '/knowledge/managed/a/b']) {
      assert.equal((await fetch(`${url}${path}`)).status, 404, path);
    }
    const posted = await fetch(`${url}/knowledge/managed`, { method: 'POST' });
    assert.equal(posted.status, 405);
    assert.equal(posted.headers.get('allow'), 'GET');
    // 体检详情独立页随 HTML 渲染层退役、差集并入 skill 详情的体检面板；旧地址只留 404，不留第二份实现。
    assert.equal((await fetch(`${url}/knowledge/doctors/doctor-test?skill=review`)).status, 404);
  }, 20000);

  it('projects a failing managed root to 503 without leaking the cause', async () => {
    const url = await startHost({ managedDir: () => { throw new Error('EACCES /private/token'); } });
    const response = await fetch(`${url}/knowledge/managed`);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'studio_source_unavailable');
  }, 20000);

  it('does not intercept the managed pages when the host trims the Studio page group', async () => {
    const url = await startHost({ managedDir: managedDirWith(managedRecord()), studioPages: false });
    for (const path of ['/knowledge/managed', '/knowledge/managed/a/b']) {
      const response = await fetch(`${url}${path}`, { redirect: 'manual' });
      assert.equal(response.status, 404, `${path} is not intercepted`);
      assert.equal(response.headers.get('location'), null, `${path} must not redirect to a page it does not serve`);
    }
  }, 20000);
});
