import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  evaluationRequestsEqual,
  isSafeEvaluationJobId,
  isValidEvaluationJob,
  isValidEvaluationRequest,
  isValidEvaluationRun,
} from '../../src/shared/evaluation-job.js';
import type { EvaluationJob, EvaluationRequest } from '../../src/types/index.js';

function request(): EvaluationRequest {
  return {
    samplesPath: 'eval-samples.json',
    skillDir: 'skills',
    artifacts: [{
      name: 'candidate',
      kind: 'skill',
      source: 'file-path',
      content: '# candidate',
      allowedSkills: [],
    }],
    model: 'gpt-5',
    executor: 'codex',
    noJudge: false,
    concurrency: 1,
    noCache: false,
    dryRun: false,
    judgeModels: [{ executor: 'codex', model: 'gpt-5' }],
    strictBaseline: true,
  };
}

function succeededJob(): EvaluationJob {
  return {
    jobId: 'job-run-1',
    status: 'succeeded',
    createdAt: '2026-07-27T00:00:00Z',
    updatedAt: '2026-07-27T00:00:02Z',
    startedAt: '2026-07-27T00:00:01Z',
    finishedAt: '2026-07-27T00:00:02Z',
    request: request(),
    runId: 'run-1',
    resultReportId: 'run-1',
  };
}

describe('evaluation job persistence protocol', () => {
  it('accepts a coherent request, run and job', () => {
    assert.equal(isSafeEvaluationJobId('job-run_1.2'), true);
    assert.equal(isValidEvaluationRequest(request()), true);
    assert.equal(isValidEvaluationRun({
      runId: 'run-1',
      startedAt: '2026-07-27T00:00:01Z',
      finishedAt: '2026-07-27T00:00:02Z',
      status: 'succeeded',
    }, 'run-1'), true);
    assert.equal(isValidEvaluationJob(succeededJob(), 'job-run-1'), true);
    assert.equal(evaluationRequestsEqual(request(), structuredClone(request())), true);
  });

  it('rejects duplicate artifact identities and malformed audit knobs', () => {
    const duplicate = request();
    duplicate.artifacts.push({ ...duplicate.artifacts[0] });
    assert.equal(isValidEvaluationRequest(duplicate), false);

    const malformed = { ...request(), strictBaseline: 'false' };
    assert.equal(isValidEvaluationRequest(malformed), false);
  });

  it('rejects impossible run and job timelines', () => {
    assert.equal(isValidEvaluationRun({
      runId: 'run-1',
      startedAt: '2026-07-27T00:00:02Z',
      finishedAt: '2026-07-27T00:00:01Z',
      status: 'succeeded',
    }), false);

    const staleUpdate = succeededJob();
    staleUpdate.updatedAt = '2026-07-27T00:00:01Z';
    assert.equal(isValidEvaluationJob(staleUpdate), false);
  });

  it('rejects unsafe job identities and incoherent terminal state', () => {
    assert.equal(isSafeEvaluationJobId('../job'), false);
    const missingReport = succeededJob();
    delete missingReport.resultReportId;
    assert.equal(isValidEvaluationJob(missingReport), false);
  });
});
