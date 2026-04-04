import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileJobStore } from '../lib/job-store.js';
import type { EvaluationJob, EvaluationRequest, JobStore } from '../lib/types.js';

const mockRequest: EvaluationRequest = {
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
    const updated = await store.update('j1', (j) => ({ ...j, status: 'running' as const }));
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
  });

  it('get 不存在的 id 返回 null', async () => {
    const result = await store.get('nonexistent');
    assert.equal(result, null);
  });
});
