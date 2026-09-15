import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body,
      }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe('Studio observation routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-observation-routes-'));
  const observationsDir = join(root, 'observations');
  let server: ReturnType<typeof createReportServer> | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    server = createReportServer({
      port: 0,
      observationsDir,
      analysesDir: join(root, 'analyses'),
      doctorsDir: join(root, 'doctors'),
    });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the inbox API contract while the page moved to the Next host', async () => {
    // 收口后 /observe/inbox 页面由 Next 宿主渲染；report-server 层不再回落 HTML 页面。
    const page = await request(`${baseUrl}/observe/inbox?skill=audit`);
    assert.equal(page.status, 404);

    const items = await request(`${baseUrl}/api/observe-inbox?severity=high&limit=1`);
    assert.equal(items.status, 200);
    assert.deepEqual(JSON.parse(items.body), []);

    const pageRedirect = await request(`${baseUrl}/observations/inbox?skill=audit`);
    assert.equal(pageRedirect.status, 404);
    assert.equal(pageRedirect.headers.location, undefined);

    const apiLegacy = await request(
      `${baseUrl}/api/observations/review-state?targetType=skill&targetId=audit`,
      { method: 'DELETE' },
    );
    assert.equal(apiLegacy.status, 404);
    assert.equal(apiLegacy.headers.location, undefined);
  });

  it('validates and persists review-state mutations through the shared request boundary', async () => {
    const endpoint = `${baseUrl}/api/observe-inbox/review-state`;
    const contentTypeRejected = await request(endpoint, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(contentTypeRejected.status, 415);
    assert.deepEqual(JSON.parse(contentTypeRejected.body), { error: 'unsupported_media_type' });
    assert.equal(contentTypeRejected.headers['cache-control'], 'no-store');

    const crossOriginRejected = await request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://untrusted.example',
      },
      body: '{}',
    });
    assert.equal(crossOriginRejected.status, 403);
    assert.deepEqual(JSON.parse(crossOriginRejected.body), { error: 'mutation_not_trusted' });

    const malformed = await request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(JSON.parse(malformed.body), { error: 'json_body_not_object' });

    const invalidJson = await request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken',
    });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(JSON.parse(invalidJson.body), { error: 'invalid_json_body' });

    const missingFields = await request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(missingFields.status, 400);
    assert.deepEqual(JSON.parse(missingFields.body), { error: 'invalid_review_state' });

    const tooLarge = await request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"padding":"${'x'.repeat(1024 * 1024)}"}`,
    });
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(JSON.parse(tooLarge.body), { error: 'request_body_too_large' });

    const saved = await request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: 'skill',
        targetId: 'audit',
        verdict: 'reviewed',
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(saved.body).entries['skill:audit'].verdict, 'reviewed');

    const loaded = await request(endpoint);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(loaded.body).entries['skill:audit'].targetId, 'audit');

    const deleted = await request(`${endpoint}?targetType=skill&targetId=audit`, {
      method: 'DELETE',
    });
    assert.equal(deleted.status, 200);
    assert.equal(JSON.parse(deleted.body).entries['skill:audit'], undefined);

    const unsupported = await request(endpoint, { method: 'PUT' });
    assert.equal(unsupported.status, 405);
    assert.deepEqual(JSON.parse(unsupported.body), { error: 'method_not_allowed' });
    assert.equal(unsupported.headers.allow, 'DELETE, GET, POST');
  });

  it('retires the inbox show and diagnostics JSON routes', async () => {
    // #902 §一：渲染层收敛后这两条机读投影只剩测试读者，一律退出，不补重定向、不留兼容别名。
    for (const path of ['/api/observe-inbox/show?id=x', '/api/observe-inbox/diagnostics']) {
      const retired = await request(`${baseUrl}${path}`);
      assert.equal(retired.status, 404, `${path} 已退出`);
      assert.equal(retired.headers.location, undefined, `${path} 不留重定向`);
      // 落到宿主统一的纯文本 404，而不是路由自己查不到对象时的 JSON 错误体。
      assert.equal(retired.body, 'Not Found', `${path} 不再由路由应答`);
    }
    // 收件箱本身仍有读者：列表与复核状态两条不受影响。
    assert.equal((await request(`${baseUrl}/api/observe-inbox`)).status, 200);
    assert.equal((await request(`${baseUrl}/api/observe-inbox/view`)).status, 200);
  });

  it('omits inbox routes when the host opts out, keeping the conversation group', async () => {
    const scoped = createReportServer({
      port: 0,
      observationsDir,
      analysesDir: join(root, 'analyses'),
      doctorsDir: join(root, 'doctors'),
      observationInbox: false,
    });
    const scopedUrl = await scoped.start();
    try {
      for (const path of [
        '/observe/inbox',
        '/api/observe-inbox',
        '/api/observe-inbox/view',
        '/api/observe-inbox/review-state',
      ]) {
        const res = await request(`${scopedUrl}${path}`);
        assert.equal(res.status, 404, `${path} should be unregistered`);
        assert.equal(res.body, 'Not Found');
      }
      const posted = await request(`${scopedUrl}/api/observe-inbox/review-state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(posted.status, 404);

      const activity = await request(`${scopedUrl}/api/conversations/activity`);
      assert.equal(activity.status, 200);
      assert.equal(JSON.parse(activity.body).revision !== undefined, true);
    } finally {
      await scoped.stop();
    }
  });
});
