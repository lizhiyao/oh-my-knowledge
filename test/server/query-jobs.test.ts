import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { queryJobList, queryJob } from '../../src/server/report-store.js';
import type { EvaluationJob, EvaluationRequest, JobStore } from '../../src/types.js';

function makeRequest(overrides: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return {
    samplesPath: '/tmp/s.json',
    skillDir: '/tmp/skills',
    artifacts: [],
    model: 'sonnet',
    judgeModel: 'haiku',
    executor: 'claude',
    noJudge: false,
    concurrency: 1,
    noCache: false,
    dryRun: false,
    blind: false,
    ...overrides,
  };
}

function makeJob(id: string, status: EvaluationJob['status'], createdAt: string, overrides: Partial<EvaluationJob> = {}): EvaluationJob {
  return {
    jobId: id,
    status,
    createdAt,
    updatedAt: createdAt,
    request: makeRequest(),
    ...overrides,
  };
}

function createMockStore(jobs: EvaluationJob[]): JobStore {
  const map = new Map(jobs.map((j) => [j.jobId, j]));
  return {
    list: async () => [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get: async (id: string) => map.get(id) ?? null,
    save: async () => { },
    update: async () => null,
    remove: async () => false,
    exists: async (id: string) => map.has(id),
  };
}

describe('queryJobList', () => {
  const jobs = [
    makeJob('j1', 'queued', '2024-01-01T00:00:00Z'),
    makeJob('j2', 'running', '2024-01-02T00:00:00Z'),
    makeJob('j3', 'succeeded', '2024-01-03T00:00:00Z'),
  ];
  const store = createMockStore(jobs);

  it('返回所有 jobs', async () => {
    const result = await queryJobList(store);
    assert.equal(result.length, 3);
  });

  it('按 status 过滤', async () => {
    const result = await queryJobList(store, { status: 'running' });
    assert.equal(result.length, 1);
    assert.equal(result[0].jobId, 'j2');
  });

  it('limit 限制数量', async () => {
    const result = await queryJobList(store, { limit: 2 });
    assert.equal(result.length, 2);
  });
});

describe('queryJob', () => {
  const store = createMockStore([makeJob('j1', 'queued', '2024-01-01T00:00:00Z')]);

  it('返回指定 id 的 job', async () => {
    const job = await queryJob(store, 'j1');
    assert.equal(job!.jobId, 'j1');
  });

  it('不存在的 id 返回 null', async () => {
    const job = await queryJob(store, 'nonexistent');
    assert.equal(job, null);
  });
});
