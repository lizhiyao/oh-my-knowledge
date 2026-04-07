import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildEvaluationRequest,
  createQueuedJob,
  markJobRunning,
  createSucceededJob,
  createFailedJob,
  createEvaluationRun,
  finalizeEvaluationRun,
  failEvaluationRun,
  classifyEvaluationError,
} from '../../src/eval-core/evaluation-job.js';
import type { EvaluationRequest } from '../../src/types.js';

const mockRequest: EvaluationRequest = {
  samplesPath: '/tmp/samples.json',
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

describe('buildEvaluationRequest', () => {
  it('返回正确的结构', () => {
    const req = buildEvaluationRequest({
      samplesPath: '/a.json',
      skillDir: '/skills',
      artifacts: [],
      model: 'sonnet',
      judgeModel: 'haiku',
      executor: 'claude',
      noJudge: false,
      concurrency: 2,
      noCache: true,
      dryRun: false,
      blind: true,
    });
    assert.equal(req.samplesPath, '/a.json');
    assert.equal(req.concurrency, 2);
    assert.equal(req.noCache, true);
    assert.equal(req.blind, true);
  });
});

describe('createQueuedJob', () => {
  it('status 为 queued，有时间戳', () => {
    const job = createQueuedJob({ jobId: 'j1', request: mockRequest, createdAt: '2024-01-01T00:00:00Z' });
    assert.equal(job.status, 'queued');
    assert.equal(job.jobId, 'j1');
    assert.equal(job.createdAt, '2024-01-01T00:00:00Z');
    assert.equal(job.updatedAt, '2024-01-01T00:00:00Z');
  });
});

describe('markJobRunning', () => {
  it('status 变为 running，有 runId', () => {
    const queued = createQueuedJob({ jobId: 'j1', request: mockRequest });
    const running = markJobRunning(queued, 'run-1', '2024-01-01T01:00:00Z');
    assert.equal(running.status, 'running');
    assert.equal(running.runId, 'run-1');
    assert.equal(running.startedAt, '2024-01-01T01:00:00Z');
  });
});

describe('createSucceededJob', () => {
  it('status 为 succeeded，有 reportId', () => {
    const job = createSucceededJob({
      jobId: 'j1',
      runId: 'run-1',
      reportId: 'rpt-1',
      request: mockRequest,
      createdAt: '2024-01-01T00:00:00Z',
      startedAt: '2024-01-01T01:00:00Z',
      finishedAt: '2024-01-01T02:00:00Z',
    });
    assert.equal(job.status, 'succeeded');
    assert.equal(job.resultReportId, 'rpt-1');
    assert.equal(job.runId, 'run-1');
  });
});

describe('createFailedJob', () => {
  it('status 为 failed，有 error 和 errorCategory', () => {
    const queued = createQueuedJob({ jobId: 'j1', request: mockRequest });
    const failed = createFailedJob({ job: queued, error: 'timed out', finishedAt: '2024-01-01T03:00:00Z' });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'timed out');
    assert.equal(failed.errorCategory, 'executor');
  });
});

describe('createEvaluationRun', () => {
  it('返回 running 状态的 run', () => {
    const { run, startedAt } = createEvaluationRun('run-1', '2024-01-01T00:00:00Z');
    assert.equal(run.status, 'running');
    assert.equal(run.runId, 'run-1');
    assert.equal(startedAt, '2024-01-01T00:00:00Z');
  });
});

describe('finalizeEvaluationRun', () => {
  it('status 变为 succeeded', () => {
    const { run } = createEvaluationRun('run-1');
    const finalized = finalizeEvaluationRun(run, '2024-01-01T05:00:00Z');
    assert.equal(finalized.status, 'succeeded');
    assert.equal(finalized.finishedAt, '2024-01-01T05:00:00Z');
  });
});

describe('failEvaluationRun', () => {
  it('status 变为 failed', () => {
    const { run } = createEvaluationRun('run-1');
    const failed = failEvaluationRun(run, '2024-01-01T06:00:00Z');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.finishedAt, '2024-01-01T06:00:00Z');
  });
});

describe('classifyEvaluationError', () => {
  it('missing required field → user', () => {
    assert.equal(classifyEvaluationError('Missing required field: model'), 'user');
  });

  it('timed out → executor', () => {
    assert.equal(classifyEvaluationError('API request timed out after 30s'), 'executor');
  });

  it('judge → judge', () => {
    assert.equal(classifyEvaluationError('Failed to parse judge response'), 'judge');
  });

  it('unknown → system', () => {
    assert.equal(classifyEvaluationError('something unexpected'), 'system');
  });
});
