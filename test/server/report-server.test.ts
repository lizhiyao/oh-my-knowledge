import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createReportServer } from '../../src/server/report-server.js';

const TEST_DIR = join(tmpdir(), `omk-test-reports-${Date.now()}`);
const JOBS_DIR = join(tmpdir(), `omk-test-jobs-${Date.now()}`);

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

const SAMPLE_JOB = {
  jobId: 'job-test-run-001',
  status: 'succeeded',
  createdAt: '2026-03-25T10:00:00.000Z',
  updatedAt: '2026-03-25T10:00:02.000Z',
  startedAt: '2026-03-25T10:00:01.000Z',
  finishedAt: '2026-03-25T10:00:02.000Z',
  request: {
    samplesPath: 'eval-samples.json',
    skillDir: 'skills',
    artifacts: [],
    project: 'alpha',
    owner: 'lizhiyao',
    tags: ['smoke', 'nightly'],
    model: 'sonnet',
    judgeModel: 'haiku',
    executor: 'claude',
    judgeExecutor: 'claude',
    noJudge: false,
    concurrency: 1,
    noCache: false,
    dryRun: false,
    blind: false,
  },
  runId: 'test-run-001',
  resultReportId: 'test-run-001',
};

const FAILED_JOB = {
  jobId: 'job-test-run-002',
  status: 'failed',
  createdAt: '2026-03-25T11:00:00.000Z',
  updatedAt: '2026-03-25T11:00:03.000Z',
  startedAt: '2026-03-25T11:00:01.000Z',
  finishedAt: '2026-03-25T11:00:03.000Z',
  request: {
    samplesPath: 'eval-samples-2.json',
    skillDir: 'skills',
    artifacts: [],
    project: 'beta',
    owner: 'other-user',
    tags: ['regression'],
    model: 'sonnet',
    judgeModel: 'haiku',
    executor: 'claude',
    judgeExecutor: 'claude',
    noJudge: false,
    concurrency: 1,
    noCache: false,
    dryRun: false,
    blind: false,
  },
  runId: 'test-run-002',
  error: 'skill not found',
  errorCategory: 'user',
};

interface FetchResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function fetch(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('report-server', () => {
  let server: ReturnType<typeof createReportServer>;
  let baseUrl: string;

  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(JOBS_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'test-run-001.json'), JSON.stringify(SAMPLE_REPORT, null, 2));
    writeFileSync(join(JOBS_DIR, 'job-test-run-001.json'), JSON.stringify(SAMPLE_JOB, null, 2));
    writeFileSync(join(JOBS_DIR, 'job-test-run-002.json'), JSON.stringify(FAILED_JOB, null, 2));
    server = createReportServer({ reportsDir: TEST_DIR, jobsDir: JOBS_DIR });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server.stop();
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(JOBS_DIR, { recursive: true, force: true });
  });

  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
  });

  it('GET /api/reports returns run list', async () => {
    const res = await fetch(`${baseUrl}/api/reports`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'test-run-001');
  });

  it('GET /api/jobs returns job list', async () => {
    const res = await fetch(`${baseUrl}/api/jobs`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 2);
    assert.deepEqual(data.map((job: { jobId: string }) => job.jobId).sort(), ['job-test-run-001', 'job-test-run-002']);
  });

  it('GET /api/job/:id returns job detail', async () => {
    const res = await fetch(`${baseUrl}/api/job/job-test-run-001`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.jobId, 'job-test-run-001');
    assert.equal(data.resultReportId, 'test-run-001');
  });

  it('GET /api/jobs supports filtering by status', async () => {
    const res = await fetch(`${baseUrl}/api/jobs?status=failed`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
    assert.equal(data[0].jobId, 'job-test-run-002');
  });

  it('GET /api/jobs supports filtering by project and tag', async () => {
    const res = await fetch(`${baseUrl}/api/jobs?project=alpha&tag=nightly`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
    assert.equal(data[0].jobId, 'job-test-run-001');
  });

  it('GET /api/reports/:id returns run detail', async () => {
    const res = await fetch(`${baseUrl}/api/reports/test-run-001`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.id, 'test-run-001');
    assert.equal(data.meta.model, 'sonnet');
  });

  it('GET /api/reports/:id returns 404 for missing run', async () => {
    const res = await fetch(`${baseUrl}/api/reports/nonexistent`);
    assert.equal(res.status, 404);
  });

  it('GET / returns HTML run list', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']!.includes('text/html'));
    assert.ok(res.body.includes('test-run-001'));
  });

  it('GET /reports/:id returns HTML detail page', async () => {
    const res = await fetch(`${baseUrl}/reports/test-run-001`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']!.includes('text/html'));
    assert.ok(res.body.includes('test-run-001'));
  });

  it('DELETE /api/reports/:id removes report', async () => {
    // Create a temp report to delete
    writeFileSync(join(TEST_DIR, 'to-delete.json'), JSON.stringify({ ...SAMPLE_REPORT, id: 'to-delete' }));

    const res = await fetch(`${baseUrl}/api/reports/to-delete`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    // Verify it's gone
    const check = await fetch(`${baseUrl}/api/reports/to-delete`);
    assert.equal(check.status, 404);
  });

  it('DELETE /api/reports/:id returns 404 for missing run', async () => {
    const res = await fetch(`${baseUrl}/api/reports/nonexistent`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });

  it('GET unknown path returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    assert.equal(res.status, 404);
  });
});
