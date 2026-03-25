import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createReportServer } from '../lib/report-server.mjs';

const TEST_DIR = join(tmpdir(), `omk-test-reports-${Date.now()}`);

const SAMPLE_REPORT = {
  id: 'test-run-001',
  meta: {
    variants: ['v1', 'v2'],
    model: 'sonnet',
    judgeModel: 'haiku',
    executor: 'claude',
    sampleCount: 1,
    taskCount: 2,
    totalCostUSD: 0.01,
    timestamp: '2026-03-25T10:00:00.000Z',
  },
  summary: {
    v1: { totalSamples: 1, successCount: 1, errorCount: 0, avgCompositeScore: 4.0 },
    v2: { totalSamples: 1, successCount: 1, errorCount: 0, avgCompositeScore: 4.5 },
  },
  results: [
    {
      sample_id: 's001',
      variants: {
        v1: { ok: true, compositeScore: 4.0 },
        v2: { ok: true, compositeScore: 4.5 },
      },
    },
  ],
};

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('report-server', () => {
  let server;
  let baseUrl;

  before(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'test-run-001.json'), JSON.stringify(SAMPLE_REPORT, null, 2));
    server = createReportServer({ reportsDir: TEST_DIR });
    baseUrl = await server.start();
  });

  after(async () => {
    await server.stop();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
  });

  it('GET /api/runs returns run list', async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'test-run-001');
  });

  it('GET /api/run/:id returns run detail', async () => {
    const res = await fetch(`${baseUrl}/api/run/test-run-001`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.id, 'test-run-001');
    assert.equal(data.meta.model, 'sonnet');
  });

  it('GET /api/run/:id returns 404 for missing run', async () => {
    const res = await fetch(`${baseUrl}/api/run/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('GET / returns HTML run list', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('test-run-001'));
  });

  it('GET /run/:id returns HTML detail page', async () => {
    const res = await fetch(`${baseUrl}/run/test-run-001`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('test-run-001'));
  });

  it('POST /api/run/:id/feedback persists feedback', async () => {
    const res = await fetch(`${baseUrl}/api/run/test-run-001/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sample_id: 's001', variant: 'v1', rating: 4, comment: 'good' }),
    });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);

    // Verify feedback was saved
    const detail = await fetch(`${baseUrl}/api/run/test-run-001`);
    const report = JSON.parse(detail.body);
    const feedback = report.results[0].humanFeedback;
    assert.ok(feedback.length >= 1);
    assert.equal(feedback[0].variant, 'v1');
    assert.equal(feedback[0].rating, 4);
    assert.equal(feedback[0].comment, 'good');
  });

  it('POST /api/run/:id/feedback rejects missing fields', async () => {
    const res = await fetch(`${baseUrl}/api/run/test-run-001/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sample_id: 's001' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/run/:id/feedback returns 404 for missing sample', async () => {
    const res = await fetch(`${baseUrl}/api/run/test-run-001/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sample_id: 'nonexistent', variant: 'v1', rating: 3 }),
    });
    assert.equal(res.status, 404);
  });

  it('DELETE /api/run/:id removes report', async () => {
    // Create a temp report to delete
    writeFileSync(join(TEST_DIR, 'to-delete.json'), JSON.stringify({ ...SAMPLE_REPORT, id: 'to-delete' }));

    const res = await fetch(`${baseUrl}/api/run/to-delete`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    // Verify it's gone
    const check = await fetch(`${baseUrl}/api/run/to-delete`);
    assert.equal(check.status, 404);
  });

  it('DELETE /api/run/:id returns 404 for missing run', async () => {
    const res = await fetch(`${baseUrl}/api/run/nonexistent`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  it('GET unknown path returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    assert.equal(res.status, 404);
  });
});
