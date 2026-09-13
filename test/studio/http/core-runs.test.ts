import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';
import { createCoreStudioRouteHandler } from '../../../src/studio/http/routes/core-runs.js';
import type { CoreStudioCatalog, CoreStudioRunDetail } from '../../../src/studio/index.js';
import { card, detail } from '../fixtures/core-run-view.js';

// view-model 样板与 React 行为面测试共用 fixtures，两条渲染链断言同一份事实。
function catalog(source: CoreStudioRunDetail = detail()): CoreStudioCatalog {
  return {
    async list() { return [source.run]; },
    async get(runId) { return runId === source.run.runId ? source : undefined; },
    async inspect(runId) { return runId === source.run.runId ? source.run : undefined; },
  };
}

describe('Core Studio JSON route', () => {
  function route(source: CoreStudioRunDetail = detail()) {
    return createCoreStudioRouteHandler({ catalog: catalog(source), apiBasePath: '/api/core-runs' });
  }

  it('serves the catalog projection as machine-readable JSON', async () => {
    const handler = route();

    const list = await handler({ method: 'GET', url: '/api/core-runs?lang=en' });
    assert.equal(list?.status, 200);
    assert.ok(Object.isFrozen(list));
    assert.ok(Object.isFrozen(list?.headers));
    assert.equal(list?.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(list?.body ?? ''), [card()]);

    const detailResponse = await handler({ method: 'GET', url: '/api/core-runs/core-run-1' });
    assert.equal(detailResponse?.status, 200);
    assert.deepEqual(JSON.parse(detailResponse?.body ?? ''), detail());
  });

  it('returns stable 404/405 responses and leaves unrelated routes untouched', async () => {
    const handler = route();

    assert.equal(await handler({ method: 'GET', url: '/unrelated' }), undefined);
    // 整棵 API 子树归本路由所有：多余层级与空身份同样给出稳定 404，不落回其他宿主路由。
    for (const url of ['/api/core-runs/', '/api/core-runs/a/b']) {
      assert.equal((await handler({ method: 'GET', url }))?.status, 404, url);
    }
    assert.deepEqual(JSON.parse((await handler({ method: 'GET', url: '/api/core-runs/missing' }))?.body ?? ''), { error: 'core_run_not_found' });
    assert.equal((await handler({ method: 'GET', url: '/api/core-runs/%ZZ' }))?.status, 404);

    const method = await handler({ method: 'POST', url: '/api/core-runs/core-run-1?lang=en' });
    assert.equal(method?.status, 405);
    assert.equal(method?.headers.Allow, 'GET');
    assert.deepEqual(JSON.parse(method?.body ?? ''), { error: 'method_not_allowed' });
  });

  it('round-trips encoded run identifiers as a single route segment', async () => {
    const source = detail(card({ runId: 'group/run?1' }));
    const handler = route(source);

    const list = await handler({ url: '/api/core-runs' });
    assert.equal(JSON.parse(list?.body ?? '')[0].runId, 'group/run?1');
    assert.equal((await handler({ url: '/api/core-runs/group%2Frun%3F1' }))?.status, 200);
    // 未编码的分隔符多出一段路径，不再是一个可解码的运行身份，同样落在 404 而不是转交其他路由。
    assert.equal((await handler({ url: '/api/core-runs/group/run%3F1' }))?.status, 404);
  });

  it('redacts source failures to a stable error code', async () => {
    const unavailable: CoreStudioCatalog = {
      async list() { throw new Error('TOP-SECRET-FILESYSTEM-PATH'); },
      async get() { throw new Error('TOP-SECRET-FILESYSTEM-PATH'); },
      async inspect() { throw new Error('TOP-SECRET-FILESYSTEM-PATH'); },
    };
    const handler = createCoreStudioRouteHandler({ catalog: unavailable, apiBasePath: '/api/core-runs' });

    for (const url of ['/api/core-runs', '/api/core-runs/core-run-1']) {
      const response = await handler({ url });
      assert.equal(response?.status, 503, url);
      assert.deepEqual(JSON.parse(response?.body ?? ''), { error: 'core_studio_source_unavailable' }, url);
      assert.ok(!response?.body.includes('TOP-SECRET'), url);
    }
  });

  it('rejects ambiguous base paths at construction time', () => {
    for (const apiBasePath of ['/', '/api/core-runs/', 'api/core-runs', '/api//core-runs', '/api/core-runs?x=1', '/api/core-runs#x', '/api/core runs', '/api\\core-runs']) {
      assert.throws(
        () => createCoreStudioRouteHandler({ catalog: catalog(), apiBasePath }),
        /must be an absolute, non-root path without a trailing slash, query, or fragment/u,
        apiBasePath,
      );
    }
  });
});

describe('Evaluation catalog on the production host', () => {
  const servers: ReturnType<typeof createReportServer>[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
  });

  async function serve(options: Parameters<typeof createReportServer>[0]): Promise<string> {
    const server = createReportServer({ port: 0, ...options });
    servers.push(server);
    return server.start();
  }

  it('serves the evaluation API without mounting pages or writing observation data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-core-pages-off-'));
    try {
      const observationsDir = join(root, 'observations');
      const url = await serve({
        coreStudioCatalog: catalog(), observationsDir, studioPages: false,
      });
      // 不挂观测页面就不该为了一个用不到的目录在用户项目里落盘。
      assert.equal(existsSync(observationsDir), false);

      const list = await fetch(`${url}/api/reports`);
      assert.equal(list.status, 200);
      assert.deepEqual(await list.json(), [card()]);
      const detailResponse = await fetch(`${url}/api/reports/core-run-1`);
      assert.equal(detailResponse.status, 200);
      assert.deepEqual(await detailResponse.json(), detail());

      // HTML 渲染层删除后，评测页面的唯一入口是 Next 宿主；独立宿主只保留 JSON 资源。
      for (const path of ['/', '/measure', '/measure/core-run-1', '/observe', '/observe/inbox', '/knowledge', '/api/observe-inbox/view']) {
        const response = await fetch(`${url}${path}`, { redirect: 'manual' });
        assert.equal(response.status, 404, `${path} is not mounted on a measure-only host`);
        assert.equal(response.headers.get('location'), null, `${path} must not redirect to a page it does not serve`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('connects the production HTTP server to the evaluation catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-core-route-wiring-'));
    try {
      const url = await serve({
        coreStudioCatalog: catalog(),
        conversationCatalog: {
          async listConversations() {
            return { conversations: [], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 };
          },
          async getConversation() { return undefined; },
          async loadTaskTrajectory() { return undefined; },
        },
        observationsDir: join(root, 'observations'), doctorsDir: join(root, 'doctors'),
        analysesDir: join(root, 'analyses'), managedDir: join(root, 'managed'),
      });

      const list = await fetch(`${url}/api/reports`);
      assert.equal(list.status, 200);
      assert.deepEqual(await list.json(), [card()]);
      assert.equal((await fetch(`${url}/api/reports/core-run-1`)).status, 200);
      assert.equal((await fetch(`${url}/api/reports/missing`)).status, 404);
      assert.equal((await fetch(`${url}/api/reports`, { method: 'POST' })).status, 405);
      assert.equal((await fetch(`${url}/health`)).status, 200);

      for (const path of [
        '/measure', '/measure/core-run-1', '/measure/missing',
        '/conversations', '/conversations/thread/tasks/turn', '/reports', '/reports/core-run-1',
        '/observe-inbox', '/observe-debugger/session', '/observe/sessions/session', '/observations', '/observations/inbox',
        '/observe-health', '/observe-health/report', '/analyses', '/analyses/report',
        '/skills/audit', '/doctors/report', '/managed', '/managed/audit',
        '/skill-trend/audit', '/analyses-diff?from=a&to=b',
        '/knowledge', '/knowledge/skills/audit',
      ]) {
        const obsolete = await fetch(`${url}${path}`, { redirect: 'manual' });
        assert.equal(obsolete.status, 404, `${path} is no longer a page route`);
        assert.equal(obsolete.headers.get('location'), null);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
