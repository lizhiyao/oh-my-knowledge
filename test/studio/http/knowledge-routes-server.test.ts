import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';

describe('Studio knowledge routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-routes-'));
  const managedDir = join(root, 'managed');
  let managedResolutions = 0;
  let server: ReturnType<typeof createReportServer> | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    server = createReportServer({
      port: 0,
      analysesDir: join(root, 'analyses'),
      doctorsDir: join(root, 'doctors'),
      observationsDir: join(root, 'observations'),
      managedDir: () => {
        managedResolutions += 1;
        return managedDir;
      },
    });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps managed directory resolution lazy and scoped to managed requests', async () => {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal(managedResolutions, 0);

    const api = await fetch(`${baseUrl}/api/managed`);
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { schemaVersion: 1, rows: [] });
    assert.equal(managedResolutions, 1);

    // 受管列表与决策史两页由 Next 宿主渲染：独立 HTML 宿主按设计不挂这两个路径，也不会为它们解析受管目录。
    for (const path of ['/knowledge/managed', '/knowledge/managed/abcdef123456']) {
      const retired = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
      assert.equal(retired.status, 404, `${path} 已退役`);
      assert.equal(retired.headers.get('location'), null, `${path} 不留重定向`);
    }
    assert.equal(managedResolutions, 1);

    assert.equal((await fetch(`${baseUrl}/not-found`)).status, 404);
    assert.equal(managedResolutions, 1);
  });

  it('retires the health HTML pages on the standalone host while keeping their JSON APIs', async () => {
    // 观测健康列表/详情/趋势/差异四页改由 Next 宿主渲染；独立 HTML 宿主按设计不再挂这些路径，也不留重定向别名。
    for (const path of ['/observe/health', '/observe/health/report-a', '/observe/health-diff?from=a&to=b', '/observe/skill-trend/audit']) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
      assert.equal(response.status, 404, `${path} 已退役`);
      assert.equal(response.headers.get('location'), null, `${path} 不留重定向`);
    }
    const pageRedirect = await fetch(`${baseUrl}/analyses?lang=en`, { redirect: 'manual' });
    assert.equal(pageRedirect.status, 404);
    assert.equal(pageRedirect.headers.get('location'), null);

    const apiLegacy = await fetch(`${baseUrl}/api/analyses/report-a?lang=en`, {
      redirect: 'manual',
    });
    assert.equal(apiLegacy.status, 404);
    assert.equal(apiLegacy.headers.get('location'), null);

    // #902 §一：这四条 JSON 投影在渲染层收敛后只剩测试读者，一律退出，不补重定向、不留兼容别名。
    for (const path of ['/api/observe-health/report-a', '/api/skill-trend/audit', '/api/analyses-diff?from=a&to=b', '/api/skills/audit/diagnostics']) {
      const retired = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
      assert.equal(retired.status, 404, `${path} 已退出`);
      assert.equal(retired.headers.get('location'), null, `${path} 不留重定向`);
      // 落到宿主统一的纯文本 404，而不是路由自己查不到对象时的 JSON 错误体。
      assert.equal(await retired.text(), 'Not Found', `${path} 不再由路由应答`);
    }

    assert.equal((await fetch(`${baseUrl}/api/observe-health`)).status, 200, '列表仍是性能基线的并发探针，按机读面保留');
    assert.equal((await fetch(`${baseUrl}/static/chart.js`)).status, 404);
  });

  it('uses one resolved directory snapshot per skill-index request', async () => {
    let analysesResolutions = 0;
    let doctorResolutions = 0;
    const snapshotServer = createReportServer({
      port: 0,
      analysesDir: () => {
        analysesResolutions += 1;
        return join(root, 'analyses');
      },
      doctorsDir: () => {
        doctorResolutions += 1;
        return join(root, 'doctors');
      },
      observationsDir: join(root, 'observations'),
    });
    const url = await snapshotServer.start();
    try {
      assert.equal((await fetch(`${url}/api/skills`)).status, 200);
      assert.equal(analysesResolutions, 1, '一条请求只解析一次目录快照，不在同一条请求里读两遍');
      assert.equal(doctorResolutions, 1);
    } finally {
      await snapshotServer.stop();
    }
  });
});
