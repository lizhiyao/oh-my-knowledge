import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import {
  createEvaluationSeriesDefinition,
  createEvaluationSeriesMemberSource,
  digestCanonicalJson,
  prepareEvaluationSeriesPlan,
  runEvaluationSeries,
  schemaIdentityKey,
  type EvaluationSeriesDefinition,
  type EvaluationSeriesDefinitionInput,
  type RuntimeIdentity,
} from '../../src/eval-core/index.js';
import {
  CoreDownstreamProjectionError,
  compareGoldToCoreRun,
  projectCoreArtifactGraph,
  projectCoreEvolutionEvidence,
} from '../../src/eval-workflows/projections/index.js';
import { parseArtifactGraphDocument } from '../../src/evidence/graph/schema.js';
import {
  coreRunArtifactDirectoryName,
  createNodeCoreRunArtifactStore,
  type StoredCoreRunArtifacts,
} from '../../src/eval-workflows/artifact-store/index.js';
import { persistCoreArtifactSidecars } from '../../src/eval-workflows/orchestration/index.js';
import {
  prepareConformancePlan,
  runConformanceScenario,
  type ConformanceResult,
  type ConformanceHarnessOptions,
  type ConformanceTarget,
} from '../eval-core/conformance/harness.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

async function storedScenario(
  target: ConformanceTarget,
  mutate?: ConformanceHarnessOptions['mutate'],
): Promise<StoredCoreRunArtifacts> {
  const root = await mkdtemp(join(tmpdir(), 'omk-core-projection-'));
  temporaryDirectories.push(root);
  const runId = `projection-${target}`;
  const result = await runConformanceScenario(target, { runId, mutate });
  return createNodeCoreRunArtifactStore(root).save({
    runId,
    createdAt: '2026-08-31T12:00:00.000Z',
    plan: result.plan,
    execution: result.execution,
    evaluation: result.evaluation,
    analysis: result.analysis,
    report: result.report,
  });
}

function expectProjectionError(code: CoreDownstreamProjectionError['code']) {
  return (error: unknown): boolean => (
    error instanceof CoreDownstreamProjectionError && error.code === code
  );
}

describe('Evaluation Core downstream projections', () => {
  it('projects a Core-native graph without legacy score bands or captured content', async () => {
    const source = await storedScenario('rag');
    const graph = projectCoreArtifactGraph({
      source,
      cwd: '/workspace/project',
      generatedAt: '2026-08-31T12:01:00.000Z',
      sourcePath: '/artifacts/report.json',
      cliVersion: '0.54.0',
    });

    assert.equal(parseArtifactGraphDocument(graph), graph);
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'evaluation_run'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'target'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'execution_result'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'evaluation_result'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'analysis_result'));
    assert.ok(graph.nodes.some((node) => node.nodeKind === 'decision'));
    assert.ok(graph.edges.some((edge) => edge.edgeKind === 'observes'));
    assert.ok(graph.nodes.every((node) => node.nodeKind !== 'variant'));
    assert.ok(graph.nodes.every((node) => node.metrics?.llmScore === undefined));
    assert.ok(graph.nodes.flatMap((node) => node.evidenceRefs ?? []).every(
      (reference) => reference.sourceKind === 'evaluation-core-document',
    ));
    assert.ok(!JSON.stringify(graph).includes('evaluation core'));
    const runNode = graph.nodes.find((node) => node.nodeKind === 'evaluation_run');
    const targetNode = graph.nodes.find((node) => node.nodeKind === 'target');
    assert.ok(runNode?.stableKey.includes(source.manifest.runId));
    assert.ok(runNode?.stableKey.includes(source.report.reportDigest));
    assert.ok(targetNode?.stableKey.includes(source.plan.digests.executionPlanDigest));

    const invalid = structuredClone(source);
    invalid.report.reportId = 'different-report';
    assert.throws(
      () => projectCoreArtifactGraph({
        source: invalid,
        cwd: '/workspace/project',
        generatedAt: '2026-08-31T12:01:00.000Z',
      }),
      expectProjectionError('CORE_PROJECTION_SOURCE_INVALID'),
    );
  });

  it('persists graph and evidence card inside the owning run bundle', async () => {
    const source = await storedScenario('rag');
    const outputDirectory = await mkdtemp(join(tmpdir(), 'omk-core-sidecars-'));
    temporaryDirectories.push(outputDirectory);

    const result = await persistCoreArtifactSidecars({
      source,
      outputDirectory,
      cwd: '/workspace/project',
    });
    const derivedDir = join(
      outputDirectory,
      coreRunArtifactDirectoryName(source.manifest.runId),
      'derived',
    );
    assert.equal(result.graphPath, join(derivedDir, 'graph.json'));
    assert.equal(result.evidenceCardPath, join(derivedDir, 'card.md'));
    const card = await readFile(result.evidenceCardPath, 'utf8');
    assert.match(card, new RegExp(source.manifest.runId, 'u'));
    assert.match(card, new RegExp(source.report.reportDigest, 'u'));
    assert.match(card, /\.\.\/manifest\.json/u);
    assert.doesNotMatch(card, /captured content|source-neutral-trace/iu);
  });

  it('compares an explicitly selected numeric observation to matching gold', async () => {
    const source = await storedScenario('rag');
    const selected = source.evaluation.records.filter((record) => (
      record.targetId === 'control' && record.evaluationStatus === 'completed'
    ));
    const annotations = selected.map((record) => {
      const observation = record.evaluationStatus === 'completed'
        ? record.observations.find((entry) => entry.metricId === 'ndcg')
        : undefined;
      assert.ok(observation?.observationStatus === 'observed');
      assert.equal(observation.valueType, 'numeric');
      return { sample_id: record.sampleId, score: observation.value };
    });
    const result = compareGoldToCoreRun({
      source,
      gold: {
        metadata: {
          annotator: 'independent-human-panel',
          annotatedAt: '2026-08-30',
          version: '1',
          scale: { min: 0, max: 1 },
        },
        annotations: [
          ...annotations,
          { sample_id: 'missing-sample', score: 0.5 },
        ],
        sourcePaths: ['/gold/annotations.yaml'],
      },
      selector: {
        targetId: 'control',
        evaluatorId: 'retrieval',
        metricId: 'ndcg',
        instrumentId: 'retrieval-metrics',
        ensembleMemberId: 'retrieval-local',
        replicateGroupId: 'retrieval-primary',
        replicateIndex: 0,
        trialIndex: 0,
      },
      bootstrapSamples: 20,
      bootstrapSeed: 42,
    });

    assert.equal(result.projectionKind, 'core-gold-comparison');
    assert.equal(result.schemaVersion, 'omk.core-gold-comparison/v2');
    assert.equal(result.analysisMode, 'exploratory-post-hoc');
    assert.equal(result.agreementPolicy, undefined);
    assert.equal(result.assessment.assessmentStatus, 'inconclusive');
    assert.ok(result.assessment.reasonCodes.includes(
      'gold-agreement-threshold-not-configured',
    ));
    assert.equal(result.agreement.sampleCount, 2);
    assert.equal(result.agreement.alpha, 1);
    assert.deepEqual(result.missingSampleIds, ['missing-sample']);
    assert.deepEqual(result.unscoredSampleIds, []);
    assert.deepEqual(result.unannotatedSampleIds, []);
    assert.deepEqual(result.notApplicableSampleIds, []);
    assert.ok(result.rows.every((row) => row.difference === 0));
    assert.equal(result.contaminationWarning, undefined);
    assert.match(result.gold.datasetDigest, /^sha256:[0-9a-f]{64}$/);

    const empty = compareGoldToCoreRun({
      source,
      gold: {
        metadata: {
          annotator: 'independent-human-panel',
          annotatedAt: '2026-08-30',
          version: '1',
          scale: { min: 0, max: 1 },
        },
        annotations: [{ sample_id: 'missing-sample', score: 0.5 }],
        sourcePaths: ['/gold/annotations.yaml'],
      },
      selector: {
        targetId: 'control',
        evaluatorId: 'retrieval',
        metricId: 'ndcg',
        trialIndex: 0,
      },
      bootstrapSamples: 20,
      bootstrapSeed: 42,
    });
    assert.equal(empty.agreement.alpha, null);
    assert.equal(empty.agreement.alphaCI.intervalStatus, 'missing');
    assert.equal(empty.agreement.weightedKappa, null);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(empty)) as unknown);

    const opposedGold = {
      metadata: {
        annotator: 'independent-human-panel',
        annotatedAt: '2026-08-30',
        version: '1',
        scale: { min: 0, max: 1 },
      },
      annotations: annotations.map((annotation) => ({
        sample_id: annotation.sample_id,
        score: annotation.score === 0 ? 1 : 0,
      })),
      sourcePaths: ['/gold/annotations.yaml'],
    } as const;
    const explicitPolicyInput = {
      source,
      gold: opposedGold,
      selector: {
        targetId: 'control',
        evaluatorId: 'retrieval',
        metricId: 'ndcg',
        instrumentId: 'retrieval-metrics',
        ensembleMemberId: 'retrieval-local',
        replicateGroupId: 'retrieval-primary',
        replicateIndex: 0,
        trialIndex: 0,
      },
      bootstrapSamples: 100,
      bootstrapSeed: 42,
    } as const;
    const failed = compareGoldToCoreRun({ ...explicitPolicyInput, minimumAlpha: 0.8 });
    assert.deepEqual(failed.agreementPolicy, {
      criterion: 'krippendorff-alpha-ci-lower-bound',
      minimumAlpha: 0.8,
      thresholdSource: 'caller',
    });
    assert.deepEqual(failed.assessment, {
      assessmentStatus: 'failed',
      reasonCodes: ['gold-agreement-alpha-ci-below-threshold'],
    });
    const passed = compareGoldToCoreRun({ ...explicitPolicyInput, minimumAlpha: -1 });
    assert.deepEqual(passed.assessment, {
      assessmentStatus: 'passed',
      reasonCodes: ['gold-agreement-alpha-ci-meets-threshold'],
    });
  });

  it('rejects incompatible scales and implicit pooling across trials', async () => {
    const source = await storedScenario('rag', (definition) => {
      definition.experiment.trials = 2;
      definition.experiment.sampling.repeatedMeasures = true;
    });
    const base = {
      source,
      gold: {
        metadata: {
          annotator: 'human',
          annotatedAt: '2026-08-30',
          version: '1',
          scale: { min: 0, max: 1 },
        },
        annotations: [{ sample_id: 'sample-1', score: 1 }],
        sourcePaths: ['/gold/annotations.yaml'],
      },
      selector: {
        targetId: 'control',
        evaluatorId: 'retrieval',
        metricId: 'ndcg',
      },
    } as const;
    let ambiguity: unknown;
    try {
      compareGoldToCoreRun(base);
    } catch (error: unknown) {
      ambiguity = error;
    }
    assert.ok(expectProjectionError('CORE_GOLD_OBSERVATION_AMBIGUOUS')(ambiguity));
    assert.ok(ambiguity instanceof Error);
    assert.ok(!ambiguity.message.includes('sample-1'));
    assert.throws(
      () => compareGoldToCoreRun({
        ...base,
        gold: {
          ...base.gold,
          metadata: { ...base.gold.metadata, scale: { min: 1, max: 5 } },
        },
        selector: { ...base.selector, trialIndex: 0 },
      }),
      expectProjectionError('CORE_GOLD_SCALE_INCOMPATIBLE'),
    );
    assert.throws(
      () => compareGoldToCoreRun({ ...base, minimumAlpha: 1.1 }),
      expectProjectionError('CORE_GOLD_POLICY_INVALID'),
    );
    assert.throws(
      () => compareGoldToCoreRun({ ...base, bootstrapSamples: 0 }),
      expectProjectionError('CORE_GOLD_POLICY_INVALID'),
    );
    assert.throws(
      () => compareGoldToCoreRun({ ...base, bootstrapSeed: -1 }),
      expectProjectionError('CORE_GOLD_POLICY_INVALID'),
    );
  });

  it('warns when the gold annotator matches the sealed evaluator model identity', async () => {
    const source = await storedScenario('rag', (definition) => {
      definition.evaluators[0].config = {
        runtime: { executorId: 'anthropic-api', model: 'judge-a' },
      };
    });
    const record = source.evaluation.records.find((entry) => (
      entry.targetId === 'control' && entry.evaluationStatus === 'completed'
    ));
    assert.ok(record?.evaluationStatus === 'completed');
    const observation = record.observations.find((entry) => entry.metricId === 'ndcg');
    assert.ok(observation?.observationStatus === 'observed');
    assert.equal(observation.valueType, 'numeric');

    const result = compareGoldToCoreRun({
      source,
      gold: {
        metadata: {
          annotator: 'ANTHROPIC-API:JUDGE-A',
          annotatedAt: '2026-08-30',
          version: '1',
          scale: { min: 0, max: 1 },
        },
        annotations: [{ sample_id: record.sampleId, score: observation.value }],
        sourcePaths: ['/gold/annotations.yaml'],
      },
      selector: {
        targetId: 'control',
        evaluatorId: 'retrieval',
        metricId: 'ndcg',
        trialIndex: 0,
      },
      bootstrapSamples: 100,
      bootstrapSeed: 42,
    });

    assert.match(result.contaminationWarning ?? '', /exactly matches/);
  });
});

const seriesOutputSchema = {
  schemaVersion: 'omk.test-series-scalar/v1',
  schemaUri: 'urn:omk:test-series-scalar:v1',
  schemaDigest: digestCanonicalJson({ schema: 'test-series-scalar', version: 1 }),
};

function seriesIdentity(implementationId: string): RuntimeIdentity {
  return {
    implementationId,
    version: '1.0.0',
    fingerprint: digestCanonicalJson({ implementationId, version: 1 }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'verified',
    capabilities: { experimentalUnit: 'run' },
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  };
}

function seriesDefinition(): EvaluationSeriesDefinitionInput {
  return {
    schemaVersion: 'omk.evaluation-series-definition/v1',
    seriesId: 'evolution-series',
    analysisMode: 'preregistered',
    experimentalUnit: 'run',
    members: [
      { memberId: 'candidate-a', replicateIndex: 0 },
      { memberId: 'candidate-b', replicateIndex: 1 },
    ],
    comparabilityPolicy: {
      designMode: 'exact-measurement-design',
      comparisonScope: 'analysis',
      minimumStatus: 'conditional',
    },
    analysisGraph: {
      nodes: [{
        nodeId: 'progress-analysis',
        implementationId: 'series-progress/v1',
        analysisStandardId: 'series-progress/v1',
        minimumMemberEvidenceStatus: 'complete',
        inputs: [{ seriesInputKind: 'members', referenceId: 'evolution-series' }],
        outputResultId: 'progress-result',
      }],
    },
    decisionPolicy: {
      decisionPolicyId: 'evolution-gate',
      implementationId: 'evolution-gate/v1',
      analysisResultIds: ['progress-result'],
      minimumCoverageRatio: 1,
      minimumMemberEvidenceStatus: 'complete',
    },
  };
}

async function seriesMemberResult(
  series: EvaluationSeriesDefinition,
  memberId: string,
  replicateIndex: number,
): Promise<ConformanceResult> {
  const plan = await prepareConformancePlan('function', (definition) => {
    definition.seriesMembership = {
      seriesDesignDigest: series.seriesDesignDigest,
      memberId,
      replicateIndex,
    };
  });
  return runConformanceScenario('function', {
    runId: `series-${memberId}`,
    plan,
  });
}

describe('Evaluation Core evolution projection', () => {
  it('preserves run-level Series evidence and only exposes the registered verdict', async () => {
    const definition = createEvaluationSeriesDefinition(seriesDefinition());
    const analysisIdentity = seriesIdentity('series-progress/v1');
    const decisionIdentity = seriesIdentity('evolution-gate/v1');
    const plan = prepareEvaluationSeriesPlan(definition, [
      {
        runtimeKind: 'series-analysis-node',
        referenceId: 'progress-analysis',
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
      },
      {
        runtimeKind: 'series-decision-policy',
        referenceId: 'evolution-gate',
        identity: decisionIdentity,
      },
    ]);
    const first = await seriesMemberResult(definition, 'candidate-a', 0);
    const second = await seriesMemberResult(definition, 'candidate-b', 1);
    const members = [
      createEvaluationSeriesMemberSource({
        memberId: 'candidate-a',
        replicateIndex: 0,
        plan: first.plan,
        execution: first.executionSource,
        evaluation: first.evaluationSource,
        analysis: first.analysisSource,
        ...(first.decisionSource === undefined ? {} : { decision: first.decisionSource }),
        report: first.report,
      }),
      createEvaluationSeriesMemberSource({
        memberId: 'candidate-b',
        replicateIndex: 1,
        plan: second.plan,
        execution: second.executionSource,
        evaluation: second.evaluationSource,
        analysis: second.analysisSource,
        ...(second.decisionSource === undefined ? {} : { decision: second.decisionSource }),
        report: second.report,
      }),
    ];
    const result = await runEvaluationSeries(plan, members, {
      analysisNodesByNodeId: new Map([['progress-analysis', {
        identity: analysisIdentity,
        outputSchema: seriesOutputSchema,
        async openRun() {
          return {
            async analyze(context) {
              return {
                analysisStatus: 'completed' as const,
                resultType: 'scalar' as const,
                value: context.coverage.comparable / context.coverage.planned,
                assumptionChecks: [{
                  assumptionId: 'all-runs-comparable',
                  checkStatus: 'passed' as const,
                }],
              };
            },
            dispose() {},
          };
        },
      }]]),
      decisionPoliciesByDecisionPolicyId: new Map([['evolution-gate', {
        identity: decisionIdentity,
        async openRun() {
          return {
            async decide() {
              return {
                decisionStatus: 'decided' as const,
                verdict: 'progress-supported',
                reasonCodes: ['series-evidence-passed'],
              };
            },
            dispose() {},
          };
        },
      }]]),
      schemaValidators: new Map([[schemaIdentityKey(seriesOutputSchema), {
        schema: seriesOutputSchema,
        parse(value: unknown) {
          return value as never;
        },
      }]]),
      clock: { timestamp: () => '2026-01-01T00:00:00.000Z' },
    }, {
      runId: 'evolution-series-run',
      bundleId: 'evolution-analysis',
      reportId: 'evolution-report',
    });

    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') throw new Error('Expected completed Series result.');

    const projection = projectCoreEvolutionEvidence({
      plan,
      analysis: result.analysis,
      report: result.report,
    });
    assert.equal(projection.experimentalUnit, 'run');
    assert.equal(projection.evidenceReadiness, 'decision-ready');
    assert.deepEqual(projection.members.map((member) => member.comparabilityStatus), [
      'anchor',
      'conditional',
    ]);
    assert.equal(projection.analyses[0].analysisStatus, 'completed');
    assert.deepEqual(projection.decision, {
      decisionStatus: 'decided',
      decisionPolicyId: 'evolution-gate',
      verdict: 'progress-supported',
      reasonCodes: ['series-evidence-passed'],
      decisionDigest: result.decision?.decisionDigest,
    });

    const mismatched = structuredClone(result.report);
    mismatched.seriesPlanDigest = digestCanonicalJson({ mismatch: true });
    assert.throws(
      () => projectCoreEvolutionEvidence({ plan, analysis: result.analysis, report: mismatched }),
      expectProjectionError('CORE_SERIES_SOURCE_INVALID'),
    );
  });
});
