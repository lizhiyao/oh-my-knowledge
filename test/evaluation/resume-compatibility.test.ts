import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildEvaluationRequest } from '../../src/eval-core/evaluation-job.js';
import { aggregateReport } from '../../src/eval-core/evaluation-reporting.js';
import { checkResumeCompatibility } from '../../src/eval-core/resume-compatibility.js';
import type {
  Artifact,
  Report,
  Sample,
  Task,
  VariantResult,
} from '../../src/types/index.js';

const sample: Sample = {
  sample_id: 's1',
  prompt: 'answer',
  assertions: [{ type: 'contains', value: 'ok' }],
};
const artifact: Artifact = {
  name: 'candidate',
  kind: 'skill',
  source: 'inline',
  content: 'instructions',
  contentHash: 'artifact-v1',
  experimentRole: 'treatment',
  allowedSkills: [],
};
const task: Task = {
  sample_id: sample.sample_id,
  variant: artifact.name,
  artifact,
  prompt: sample.prompt,
  rubric: null,
  assertions: sample.assertions ?? null,
  dimensions: null,
  artifactContent: artifact.content,
  cwd: null,
  _sample: sample,
};
const result: VariantResult = {
  ok: true,
  durationMs: 10,
  durationApiMs: 9,
  inputTokens: 2,
  outputTokens: 1,
  totalTokens: 3,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  execCostUSD: 0.01,
  judgeCostUSD: 0.02,
  costUSD: 0.03,
  numTurns: 1,
  outputPreview: 'ok',
  compositeScore: 5,
};
const baseCurrent = {
  variants: [artifact.name],
  model: 'model-a',
  executorName: 'custom-executor',
  effort: 'low' as const,
  noJudge: false,
  judgeModels: [{ executor: 'custom-judge', model: 'judge-a' }],
  judgeRepeat: 2,
  lengthDebias: true,
  budget: { totalUSD: 2 },
  timeoutMs: 10_000,
  retry: 1,
  noDiagnostic: false,
  skillDir: '/tmp/skill',
  samples: [sample],
  samplesBaseDir: '/tmp',
  tasks: [task],
  artifacts: [artifact],
};

function makeReport(): Report {
  const request = buildEvaluationRequest({
    samplesPath: '/tmp/samples.json',
    skillDir: baseCurrent.skillDir,
    artifacts: [artifact],
    model: baseCurrent.model,
    executor: baseCurrent.executorName,
    noJudge: false,
    concurrency: 1,
    timeoutMs: baseCurrent.timeoutMs,
    noCache: false,
    dryRun: false,
    judgeRepeat: baseCurrent.judgeRepeat,
    judgeModels: baseCurrent.judgeModels,
    lengthDebias: true,
    budget: baseCurrent.budget,
    strictBaseline: true,
    effort: baseCurrent.effort,
    retry: baseCurrent.retry,
    noDiagnostic: baseCurrent.noDiagnostic,
  });
  return aggregateReport({
    runId: 'resume-source',
    variants: [artifact.name],
    model: baseCurrent.model,
    judgeModel: baseCurrent.judgeModels[0].model,
    noJudge: false,
    executorName: baseCurrent.executorName,
    samples: [sample],
    samplesBaseDir: baseCurrent.samplesBaseDir,
    tasks: [task],
    results: { s1: { candidate: result } },
    totalCostUSD: result.costUSD,
    artifacts: [artifact],
    request,
  });
}

describe('resume compatibility', () => {
  it('接受完整测量契约一致的报告', () => {
    assert.deepEqual(checkResumeCompatibility(makeReport(), baseCurrent), {
      compatible: true,
      mismatches: [],
    });
  });

  it('拒绝 sample 或 artifact 内容指纹变化', () => {
    const changedSample = { ...sample, prompt: 'changed' };
    const sampleCheck = checkResumeCompatibility(makeReport(), {
      ...baseCurrent,
      samples: [changedSample],
      tasks: [{ ...task, prompt: changedSample.prompt, _sample: changedSample }],
    });
    assert.equal(sampleCheck.compatible, false);
    assert.ok(sampleCheck.mismatches.includes('meta.sampleHashes'));

    const changedArtifact = { ...artifact, contentHash: 'artifact-v2' };
    const artifactCheck = checkResumeCompatibility(makeReport(), {
      ...baseCurrent,
      artifacts: [changedArtifact],
      tasks: [{ ...task, artifact: changedArtifact }],
    });
    assert.equal(artifactCheck.compatible, false);
    assert.ok(artifactCheck.mismatches.includes('meta.artifactHashes'));
  });

  it('拒绝 runtime、评委和执行协议变化', () => {
    const nodeReport = makeReport();
    nodeReport.meta.nodeVersion = 'v0.0.0';
    assert.ok(
      checkResumeCompatibility(nodeReport, baseCurrent)
        .mismatches.includes('meta.nodeVersion'),
    );

    const runtimeReport = makeReport();
    runtimeReport.meta.executorRuntimes!.candidate.fingerprint = 'changed-runtime';
    assert.ok(
      checkResumeCompatibility(runtimeReport, baseCurrent)
        .mismatches.includes('meta.executorRuntimes'),
    );

    assert.ok(
      checkResumeCompatibility(makeReport(), {
        ...baseCurrent,
        judgeModels: [{ executor: 'custom-judge', model: 'judge-b' }],
      }).mismatches.includes('meta.judgeModels'),
    );
    assert.ok(
      checkResumeCompatibility(makeReport(), {
        ...baseCurrent,
        retry: 2,
      }).mismatches.includes('meta.request.retry'),
    );
    assert.ok(
      checkResumeCompatibility(makeReport(), {
        ...baseCurrent,
        budget: { totalUSD: 3 },
      }).mismatches.includes('meta.request.budget'),
    );
    assert.ok(
      checkResumeCompatibility(makeReport(), {
        ...baseCurrent,
        noDiagnostic: true,
      }).mismatches.includes('meta.request.noDiagnostic'),
    );
  });

  it('noJudge 且仍启用 diagnostic 时可凭独立诊断契约安全恢复', () => {
    const report = makeReport();
    report.meta.noJudge = true;
    report.meta.judgePromptHash = undefined;
    report.meta.judgeModels = report.meta.judgeModels.map(({ executor, model }) => ({
      executor,
      model,
    }));
    report.meta.request!.noJudge = true;
    const checked = checkResumeCompatibility(report, {
      ...baseCurrent,
      noJudge: true,
      noDiagnostic: false,
    });
    assert.deepEqual(checked, { compatible: true, mismatches: [] });
  });
});
