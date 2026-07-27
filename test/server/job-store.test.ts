import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileJobStore } from '../../src/server/job-store.js';
import type { EvaluationJob, EvaluationRequest, JobStore } from '../../src/types/index.js';

const mockRequest: EvaluationRequest = {
  samplesPath: '/tmp/s.json',
  skillDir: '/tmp/skills',
  artifacts: [],
  model: 'sonnet',
  judgeModels: [{ executor: 'claude', model: 'haiku' }],
  executor: 'claude',
  noJudge: false,
  concurrency: 1,
  noCache: false,
  dryRun: false,
};

function makeJob(id: string, createdAt: string): EvaluationJob {
  return {
    jobId: id,
    status: 'queued',
    createdAt,
    updatedAt: createdAt,
    request: mockRequest,
  };
}

describe('createFileJobStore', () => {
  let dir: string;
  let store: JobStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omk-job-store-'));
    store = createFileJobStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('save 和 get', async () => {
    const job = makeJob('j1', '2024-01-01T00:00:00Z');
    await store.save('j1', job);
    const fetched = await store.get('j1');
    assert.deepEqual(fetched, job);
  });

  it('list 按 createdAt 降序', async () => {
    await store.save('a', makeJob('a', '2024-01-01T00:00:00Z'));
    await store.save('b', makeJob('b', '2024-01-03T00:00:00Z'));
    await store.save('c', makeJob('c', '2024-01-02T00:00:00Z'));
    const jobs = await store.list();
    assert.equal(jobs.length, 3);
    assert.equal(jobs[0].jobId, 'b');
    assert.equal(jobs[1].jobId, 'c');
    assert.equal(jobs[2].jobId, 'a');
  });

  it('update 修改 job', async () => {
    const job = makeJob('j1', '2024-01-01T00:00:00Z');
    await store.save('j1', job);
    const updated = await store.update('j1', (j) => ({
      ...j,
      status: 'running' as const,
      runId: 'r1',
      startedAt: '2024-01-01T00:00:01Z',
      updatedAt: '2024-01-01T00:00:01Z',
    }));
    assert.equal(updated!.status, 'running');
    const fetched = await store.get('j1');
    assert.equal(fetched!.status, 'running');
  });

  it('remove 删除 job', async () => {
    await store.save('j1', makeJob('j1', '2024-01-01T00:00:00Z'));
    const removed = await store.remove('j1');
    assert.equal(removed, true);
    const fetched = await store.get('j1');
    assert.equal(fetched, null);
  });

  it('exists 返回 true/false', async () => {
    assert.equal(await store.exists('j1'), false);
    await store.save('j1', makeJob('j1', '2024-01-01T00:00:00Z'));
    assert.equal(await store.exists('j1'), true);
    writeFileSync(join(dir, 'corrupt.json'), '{');
    assert.equal(await store.exists('corrupt'), false, '损坏文件不算存在');
  });

  it('get 不存在的 id 返回 null', async () => {
    const result = await store.get('nonexistent');
    assert.equal(result, null);
  });

  it('拒绝越界 id，且不会读取 jobs 目录之外的 JSON', async () => {
    const outside = join(dir, '..', `omk-job-outside-${Date.now()}.json`);
    writeFileSync(outside, JSON.stringify(makeJob('outside', '2024-01-01T00:00:00Z')));
    try {
      assert.equal(await store.get(`../${outside.split('/').pop()!.replace(/\.json$/, '')}`), null);
      assert.equal(await store.exists('../outside'), false);
      assert.equal(await store.remove('../outside'), false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('list 跳过损坏或文件名与 jobId 不一致的记录', async () => {
    await store.save('valid', makeJob('valid', '2024-01-01T00:00:00Z'));
    writeFileSync(join(dir, 'broken.json'), '{');
    writeFileSync(join(dir, 'mismatch.json'), JSON.stringify(makeJob('other', '2024-01-02T00:00:00Z')));
    writeFileSync(join(dir, '%invalid.json'), JSON.stringify(makeJob('%invalid', '2024-01-03T00:00:00Z')));

    const jobs = await store.list();
    assert.deepEqual(jobs.map((job) => job.jobId), ['valid']);
  });

  it('save 和 update 拒绝身份错配或无效的持久化载荷', async () => {
    await assert.rejects(
      store.save('expected', makeJob('other', '2024-01-01T00:00:00Z')),
      /invalid job/,
    );

    await store.save('valid', makeJob('valid', '2024-01-01T00:00:00Z'));
    await assert.rejects(
      store.update('valid', (job) => ({
        ...job,
        request: { ...job.request, tags: {} as unknown as string[] },
      })),
      /invalid job/,
    );
    assert.deepEqual((await store.get('valid'))?.request.tags, undefined);

    const invalidJobs = [
      {
        ...makeJob('missing-judges', '2024-01-01T00:00:00Z'),
        request: { ...mockRequest, judgeModels: undefined },
      },
      {
        ...makeJob('bad-artifact', '2024-01-01T00:00:00Z'),
        request: {
          ...mockRequest,
          artifacts: [{ name: 'x', kind: 'not-an-artifact' }],
        },
      },
      {
        ...makeJob('bad-budget', '2024-01-01T00:00:00Z'),
        request: { ...mockRequest, budget: { perSampleMs: -1 } },
      },
      {
        ...makeJob('time-travel', '2024-01-02T00:00:00Z'),
        updatedAt: '2024-01-01T00:00:00Z',
      },
      {
        ...makeJob('offset-time-travel', '2024-01-02T00:00:00+08:00'),
        updatedAt: '2024-01-01T15:00:00Z',
      },
      {
        ...makeJob('incoherent-running', '2024-01-01T00:00:00Z'),
        status: 'running',
      },
      {
        ...makeJob('incoherent-success', '2024-01-01T00:00:00Z'),
        status: 'succeeded',
        startedAt: '2024-01-01T00:00:01Z',
        finishedAt: '2024-01-01T00:00:02Z',
        runId: 'r1',
      },
    ];
    for (const job of invalidJobs) {
      await assert.rejects(
        store.save(job.jobId, job as unknown as EvaluationJob),
        /invalid job/,
      );
    }
  });
});
