import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createReportServer } from '../../src/server/report-server.js';

const TEST_DIR = join(tmpdir(), `omk-test-reports-${Date.now()}`);
const JOBS_DIR = join(tmpdir(), `omk-test-jobs-${Date.now()}`);
const OBSERVATIONS_DIR = join(tmpdir(), `omk-test-observations-${Date.now()}`);

const SAMPLE_REPORT = {
  kind: 'evaluation',
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

function stripScriptAndStyle(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}

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
    mkdirSync(OBSERVATIONS_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'test-run-001.json'), JSON.stringify(SAMPLE_REPORT, null, 2));
    writeFileSync(join(JOBS_DIR, 'job-test-run-001.json'), JSON.stringify(SAMPLE_JOB, null, 2));
    writeFileSync(join(JOBS_DIR, 'job-test-run-002.json'), JSON.stringify(FAILED_JOB, null, 2));
    writeFileSync(join(OBSERVATIONS_DIR, '2026-05-07T00-00-00-observe-inbox.json'), JSON.stringify({
      kind: 'observe-inbox',
      schemaVersion: 1,
      meta: {
        tracePath: '/tmp/trace',
        generatedAt: '2026-05-07T00:00:00.000Z',
        segmentCount: 2,
        itemCount: 2,
      },
      items: [
        {
          id: 'obs-high',
          skillName: 'audit',
          artifactVersion: 'unknown',
          cwd: '/repo',
          sessionId: 's1',
          sourceTrace: '/tmp/trace/session.jsonl',
          sourceKind: 'claude',
          signalType: 'failed_search',
          signalSubtype: 'hard_miss',
          confidence: 0.9,
          attributionConfidence: 0.85,
          severity: 'high',
          severityReasonCode: 'knowledge_gap_suspected',
          evidence: { tool: 'Grep', query: 'schema' },
          firstSeen: '2026-05-07T00:00:00.000Z',
          lastSeen: '2026-05-07T00:00:00.000Z',
          occurrences: 1,
          recentSessionIds: ['s1'],
          representativeEvidence: [{ tool: 'Grep', query: 'schema' }],
        },
        {
          id: 'obs-noise',
          skillName: 'audit',
          artifactVersion: 'unknown',
          cwd: '/repo',
          sessionId: 's2',
          sourceTrace: '/tmp/trace/session.jsonl',
          sourceKind: 'claude',
          signalType: 'failed_search',
          signalSubtype: 'tool_limit',
          confidence: 0.2,
          attributionConfidence: 0.85,
          severity: 'noise',
          severityReasonCode: 'tool_or_runtime_noise',
          evidence: { tool: 'Read', path: '/repo/large.ts' },
          firstSeen: '2026-05-07T00:00:01.000Z',
          lastSeen: '2026-05-07T00:00:01.000Z',
          occurrences: 1,
          recentSessionIds: ['s2'],
          representativeEvidence: [{ tool: 'Read', path: '/repo/large.ts' }],
        },
      ],
    }, null, 2));
    server = createReportServer({ port: 0, reportsDir: TEST_DIR, observationsDir: OBSERVATIONS_DIR, jobsDir: JOBS_DIR });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server.stop();
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(JOBS_DIR, { recursive: true, force: true });
    rmSync(OBSERVATIONS_DIR, { recursive: true, force: true });
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

  it('GET /api/observations/inbox supports severity and limit query params', async () => {
    const res = await fetch(`${baseUrl}/api/observations/inbox?severity=high&limit=1`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'obs-high');
    assert.equal(data[0].severity, 'high');
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

  it('GET / returns HTML skill list (variants become skill entries)', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']!.includes('text/html'));
    // 列表页按 skill 聚合,SAMPLE_REPORT 的 variants v1/v2 各成一个 skill 条目;
    // 跳转走 /skills/<name>,不再直接暴露 reportId。
    assert.ok(res.body.includes('/skills/v1') || res.body.includes('/skills/v2'));
  });

  it('GET /reports/:id returns HTML detail page', async () => {
    const res = await fetch(`${baseUrl}/reports/test-run-001`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']!.includes('text/html'));
    assert.ok(res.body.includes('test-run-001'));
  });

  it('passes ?lang=en through skill list and detail pages', async () => {
    const list = await fetch(`${baseUrl}/?lang=en`);
    assert.equal(list.status, 200);
    assert.ok(list.body.includes('data-lang="en"'));
    // skill 列表卡片链接到 /skills/<name> 并保留 ?lang=en
    assert.ok(list.body.includes('/skills/v2?lang=en') || list.body.includes('/skills/v1?lang=en'));

    const detail = await fetch(`${baseUrl}/reports/test-run-001?lang=en`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.includes('data-lang="en"'));
    assert.ok(detail.body.includes('Evaluation Report'));
    assert.ok(detail.body.includes('Back to list'));
    assert.ok(!stripScriptAndStyle(detail.body).includes('评测报告'));
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
