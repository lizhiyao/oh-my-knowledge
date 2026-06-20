import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildEvalArtifactGraph,
  evalGraphDirForReportOutput,
} from '../../src/artifact-graph/eval.js';
import { persistReport } from '../../src/eval-core/evaluation-reporting.js';
import type { EvaluationReport, VariantResult } from '../../src/types/index.js';

function variantResult(overrides: Partial<VariantResult> = {}): VariantResult {
  return {
    ok: true,
    durationMs: 10,
    durationApiMs: 8,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    execCostUSD: 0.01,
    judgeCostUSD: 0.001,
    costUSD: 0.011,
    numTurns: 1,
    outputPreview: 'ok',
    ...overrides,
  };
}

function makeReport(): EvaluationReport {
  return {
    kind: 'evaluation',
    id: 'service-guide-20260620T103000-abcd',
    meta: {
      variants: ['baseline', 'service-guide'],
      model: 'fixture-model',
      executor: 'fixture',
      sampleCount: 1,
      taskCount: 2,
      totalCostUSD: 0.03,
      timestamp: '2026-06-20T10:30:00.000Z',
      cliVersion: '0.0.0-test',
      nodeVersion: 'v24.0.0',
      artifactHashes: {
        baseline: 'no-skill',
        'service-guide': 'skillhash1234',
      },
      sampleHashes: {
        s001: 'samplehash01',
      },
      judgeModels: [{ executor: 'fixture', model: 'judge' }],
      variantConfigs: [
        {
          variant: 'baseline',
          artifactKind: 'baseline',
          artifactSource: 'baseline',
          executionStrategy: 'baseline',
          experimentType: 'baseline',
          experimentRole: 'control',
          hasArtifactContent: false,
          cwd: null,
        },
        {
          variant: 'service-guide',
          artifactKind: 'skill',
          artifactSource: 'file-path',
          executionStrategy: 'system-prompt',
          experimentType: 'artifact-injection',
          experimentRole: 'treatment',
          hasArtifactContent: true,
          cwd: null,
          locator: 'examples/customer-service/skills/service-guide/SKILL.md',
        },
      ],
      request: {
        samplesPath: '/fixture/project/eval-samples.json',
        skillDir: '/fixture/project/skills',
        artifacts: [],
        model: 'fixture-model',
        executor: 'fixture',
        noJudge: false,
        concurrency: 1,
        noCache: false,
        dryRun: false,
        judgeModels: [{ executor: 'fixture', model: 'judge' }],
      },
    },
    summary: {
      baseline: {
        totalSamples: 1,
        successCount: 1,
        errorCount: 0,
        errorRate: 0,
        avgDurationMs: 10,
        avgInputTokens: 100,
        avgOutputTokens: 20,
        avgTotalTokens: 120,
        totalCostUSD: 0.011,
        totalExecCostUSD: 0.01,
        totalJudgeCostUSD: 0.001,
        avgCostPerSample: 0.011,
        avgNumTurns: 1,
        avgCompositeScore: 4.5,
      },
      'service-guide': {
        totalSamples: 1,
        successCount: 1,
        errorCount: 0,
        errorRate: 0,
        avgDurationMs: 12,
        avgInputTokens: 120,
        avgOutputTokens: 30,
        avgTotalTokens: 150,
        totalCostUSD: 0.019,
        totalExecCostUSD: 0.017,
        totalJudgeCostUSD: 0.002,
        avgCostPerSample: 0.019,
        avgNumTurns: 1,
        avgCompositeScore: 2.5,
      },
    },
    sampleSnapshots: {
      s001: {
        sample_id: 's001',
        prompt: '检查服务流程是否包含回滚策略。',
        assertions: [{ type: 'contains_all', values: ['回滚', '发布'] }],
        capability: ['release-readiness'],
        construct: 'capability',
        difficulty: 'medium',
        provenance: 'human',
      },
    },
    results: [{
      sample_id: 's001',
      variants: {
        baseline: variantResult({
          compositeScore: 4.5,
          assertions: {
            passed: 1,
            total: 1,
            score: 5,
            details: [{ type: 'contains_all', value: '回滚,发布', weight: 1, passed: true }],
          },
        }),
        'service-guide': variantResult({
          compositeScore: 2.5,
          assertions: {
            passed: 0,
            total: 1,
            score: 1,
            details: [{ type: 'contains_all', value: '回滚,发布', weight: 1, passed: false, message: '缺少回滚' }],
          },
          dimensions: {
            workflow: { score: 2, reason: '漏掉回滚步骤' },
          },
          diagnostic: {
            summary: '没有覆盖回滚策略。',
            expected: '回答需要包含发布与回滚。',
            actual: '只说明发布检查。',
            rootCause: ['skill_doc_missing'],
            failureModes: ['工作流跳步'],
            suggestion: { skill: '补充回滚步骤。', sample: '', none: '' },
            ok: true,
          },
        }),
      },
    }],
  };
}

describe('eval artifact graph', () => {
  it('builds a measurement-layer graph without inferred covers edges', () => {
    const report = makeReport();
    const graph = buildEvalArtifactGraph({
      report,
      sourcePath: '/tmp/.omk/reports/service-guide.report.json',
      generatedAt: '2026-06-20T10:30:00.000Z',
    });

    assert.equal(graph.documentKind, 'artifact-graph');
    assert.equal(graph.schemaVersion, 1);
    assert.equal(graph.source.sourceKind, 'eval');
    assert.equal(graph.source.sourceId, report.id);
    assert.equal(graph.scope.cwd, process.cwd());
    assert.equal(graph.scope.sourceLocator, '/fixture/project/eval-samples.json');
    assert.equal(graph.scope.sampleSetHash, '186c7ae74946');
    assert.ok(graph.nodes.every((node) => node.layer === 'measurement'));
    assert.ok(graph.edges.every((edge) => edge.layer === 'measurement'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'variant' && node.label === 'service-guide'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'skill' && node.stableKey === 'v1:skill:skillhash1234'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'sample' && node.stableKey === 'v1:sample:samplehash01'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'assertion' && node.label === 'assertion: contains_all'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'eval_result' && node.status === 'failed'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'diagnostic' && node.status === 'warning'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'judge_dimension' && node.status === 'failed'));
    assert.ok(graph.edges.some((edge) => edge.edgeKind === 'evaluates'));
    assert.ok(graph.edges.some((edge) => edge.edgeKind === 'passes'));
    assert.ok(graph.edges.some((edge) => edge.edgeKind === 'fails'));
    assert.ok(graph.edges.some((edge) => edge.edgeKind === 'diagnoses'));
    assert.ok(!graph.edges.some((edge) => edge.edgeKind === 'covers'));
  });

  it('points assertion evidence at eval result details when sample snapshot is absent', () => {
    const report = makeReport();
    report.sampleSnapshots = {};
    delete report.results[0].variants.baseline.assertions;

    const graph = buildEvalArtifactGraph({
      report,
      sourcePath: '/tmp/.omk/reports/service-guide.report.json',
      generatedAt: '2026-06-20T10:30:00.000Z',
    });
    const assertionNode = graph.nodes.find((node) => node.nodeKind === 'assertion');
    const evidence = assertionNode?.evidenceRefs?.[0];
    assert.equal(evidence?.sourceKind, 'eval-report');
    assert.equal(
      evidence?.selector?.value,
      '/results/0/variants/service-guide/assertions/details/0',
    );
  });

  it('persists eval graph sidecars when reports are written', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-eval-graph-'));
    try {
      const report = makeReport();
      const outputDir = join(tmp, '.omk', 'reports');
      const reportPath = persistReport(report, outputDir);
      assert.equal(reportPath, join(outputDir, `${report.id}.report.json`));

      const graphPath = join(tmp, '.omk', 'graphs', 'eval', `${report.id}.graph.json`);
      assert.ok(existsSync(graphPath));
      const graph = JSON.parse(readFileSync(graphPath, 'utf-8')) as { documentKind: string; source: { sourceKind: string } };
      assert.equal(graph.documentKind, 'artifact-graph');
      assert.equal(graph.source.sourceKind, 'eval');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('puts eval graph sidecars inside non-standard custom output dirs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omk-eval-graph-custom-out-'));
    try {
      const outputDir = join(tmp, 'custom-output');
      assert.equal(evalGraphDirForReportOutput(outputDir), join(outputDir, 'graphs', 'eval'));
      assert.equal(
        evalGraphDirForReportOutput(join(tmp, '.omk', 'reports')),
        join(tmp, '.omk', 'graphs', 'eval'),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
