import assert from 'node:assert/strict';
import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  EXECUTION_FACTS_SCHEMA_VERSION,
  EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
  MEASUREMENT_POLICY_SCHEMA_VERSION,
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  createEvaluationEngine,
  digestCanonicalJson,
  resolveBuiltinAnalysisRuntime,
} from 'oh-my-knowledge';
import {
  COMPARABILITY_POLICY_SCHEMA_VERSION,
  EVALUATION_CORE_JSON_SCHEMA_FILES,
  assessComparability,
  createComparabilityPolicy,
  createEvaluationEngine as createAdvancedEvaluationEngine,
  resolveEvaluationCoreJsonSchema,
} from 'oh-my-knowledge/eval-core';

assert.equal(EXECUTION_FACTS_SCHEMA_VERSION, 'omk.execution-facts/v1');

function schemaIdentity(name) {
  return {
    schemaVersion: `host.${name}/v1`,
    schemaUri: `urn:host:schema:${name}:v1`,
    schemaDigest: digestCanonicalJson({ name, version: 1 }),
  };
}

function runtimeIdentity(implementationId, capabilities) {
  const version = '1.0.0';
  return {
    implementationId,
    version,
    fingerprint: digestCanonicalJson({ implementationId, version, capabilities }),
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'verified',
    capabilities,
    implementationManifest: { coverageKind: 'fingerprint-complete' },
  };
}

function executorIdentity() {
  return runtimeIdentity('host.same-process/v1', {
    schemaVersion: EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
    protocols: [{
      protocolId: 'omk.invoke/v1',
      inputSchema: schemaIdentity('invoke-input'),
      outputSchema: schemaIdentity('invoke-output'),
      traceSchema: schemaIdentity('invoke-trace'),
      execution: {
        concurrency: { safety: 'parallel-safe' },
        cancellation: 'cooperative',
        state: { resourceLifecycle: 'per-run', trialState: 'stateless' },
        seedControl: 'optional',
        determinism: 'deterministic',
        features: {
          systemInstructions: 'unsupported',
          workspace: [],
          mcp: [],
          mockInterception: [],
          toolPolicies: ['runtime-default'],
          skillDiscovery: ['runtime-default'],
          sandboxIds: [],
        },
        telemetry: { trace: 'optional', usage: 'optional' },
      },
    }],
  });
}

function evaluatorIdentity(metricValueTypes) {
  return runtimeIdentity('host.deterministic-evaluator/v1', {
    inputSourceKinds: ['evaluation-context', 'expected', 'output', 'trace'],
    metricValueTypes,
    schemas: [],
  });
}

class HostClock {
  elapsed = 0;

  monotonicNow() {
    return this.elapsed;
  }

  timestamp() {
    const value = new Date(Date.UTC(2026, 7, 30) + this.elapsed).toISOString();
    this.elapsed += 1;
    return value;
  }

  async sleep(delayMs, signal) {
    if (signal.aborted) throw signal.reason;
    this.elapsed += delayMs;
  }
}

function object(value) {
  assert.equal(value !== null && !Array.isArray(value) && typeof value === 'object', true);
  return value;
}

function binding(context, bindingId) {
  const found = context.bindings.find((entry) => entry.bindingId === bindingId);
  assert.notEqual(found, undefined);
  return found.value;
}

function retrievalMetrics(ranking, relevantIds) {
  const relevant = new Set(relevantIds);
  const hits = ranking.filter((id) => relevant.has(id));
  const first = ranking.findIndex((id) => relevant.has(id));
  const dcg = ranking.reduce((sum, id, index) => (
    sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0
  )), 0);
  const idealLength = Math.min(relevant.size, ranking.length);
  const idcg = Array.from(
    { length: idealLength },
    (_, index) => 1 / Math.log2(index + 2),
  ).reduce((sum, value) => sum + value, 0);
  return {
    recall: relevant.size === 0 ? 1 : hits.length / relevant.size,
    mrr: first < 0 ? 0 : 1 / (first + 1),
    ndcg: idcg === 0 ? 1 : dcg / idcg,
  };
}

function createHostRuntime(targetKind) {
  const executorRuntime = executorIdentity();
  const evaluatorRuntime = evaluatorIdentity(targetKind === 'rag' ? ['numeric'] : ['boolean']);
  const executorInputs = [];
  const evaluatorInputs = [];
  const executor = {
    identity: executorRuntime,
    async openRun() {
      return {
        async openTrial(context) {
          executorInputs.push(structuredClone(context.input));
          return {
            async execute(attempt) {
              if (attempt.signal.aborted) throw attempt.signal.reason;
              const input = object(context.input);
              if (targetKind === 'rag') {
                const primary = input.query === 'evaluation core'
                  ? ['doc-a', 'doc-x', 'doc-c']
                  : ['doc-b', 'doc-y'];
                return {
                  output: {
                    value: {
                      documents: context.targetId === 'control'
                        ? primary
                        : [...primary].reverse(),
                    },
                    classification: 'public',
                  },
                };
              }
              return {
                output: {
                  value: { answer: input.answerHint },
                  classification: 'public',
                },
                trace: {
                  value: { steps: ['same-process'] },
                  classification: 'sensitive',
                },
              };
            },
            dispose() {},
          };
        },
        dispose() {},
      };
    },
  };
  const evaluator = {
    identity: evaluatorRuntime,
    async openRun() {
      return {
        async openRecord(context) {
          return {
            async evaluate(attempt) {
              if (attempt.signal.aborted) throw attempt.signal.reason;
              evaluatorInputs.push(context.evaluationId);
              if (targetKind === 'rag') {
                const ranking = binding(context, 'ranking');
                const gold = binding(context, 'gold');
                assert.equal(Array.isArray(ranking), true);
                assert.equal(Array.isArray(gold), true);
                const metrics = retrievalMetrics(ranking, gold);
                return {
                  observations: Object.entries(metrics).map(([metricId, value]) => ({
                    metricId,
                    observationStatus: 'observed',
                    valueType: 'numeric',
                    value,
                  })),
                };
              }
              return {
                observations: [{
                  metricId: 'correct',
                  observationStatus: 'observed',
                  valueType: 'boolean',
                  value: binding(context, 'actual') === binding(context, 'gold'),
                }],
              };
            },
            dispose() {},
          };
        },
        dispose() {},
      };
    },
  };
  const schemaValidators = createBuiltinAnalysisSchemaValidators();
  const analysisNodes = createBuiltinAnalysisNodes();
  const missingPolicies = createBuiltinMissingPolicies();
  const decisionPolicies = createBuiltinDecisionPolicies();
  return {
    executorInputs,
    evaluatorInputs,
    runtime: {
      bindings: {
        resolveExecutor() {
          return {
            runtimeKind: 'executor',
            resolution: { identity: executorRuntime, satisfiesVersionConstraint: true },
            port: executor,
          };
        },
        resolveEvaluator() {
          return {
            runtimeKind: 'evaluator',
            resolution: { identity: evaluatorRuntime, satisfiesVersionConstraint: true },
            port: evaluator,
          };
        },
        resolveAnalysis(requirement) {
          const resolution = resolveBuiltinAnalysisRuntime(requirement);
          if (resolution === undefined) throw new Error('Unknown built-in Analysis Runtime.');
          if (requirement.requirementKind === 'missing-policy') {
            const port = missingPolicies.get(requirement.implementationId);
            if (port === undefined) throw new Error('Unknown built-in MissingPolicy.');
            return { runtimeKind: 'missing-policy', resolution, port };
          }
          if (requirement.requirementKind === 'decision-policy') {
            const port = decisionPolicies.get(requirement.implementationId);
            if (port === undefined) throw new Error('Unknown built-in DecisionPolicy.');
            return { runtimeKind: 'decision-policy', resolution, port };
          }
          const port = analysisNodes.get(requirement.implementationId);
          if (port === undefined) throw new Error('Unknown built-in Analysis Runtime.');
          return { runtimeKind: 'analysis-node', resolution, port };
        },
      },
      clock: new HostClock(),
      schemaValidators,
    },
  };
}

function policy() {
  return {
    schemaVersion: MEASUREMENT_POLICY_SCHEMA_VERSION,
    execution: { maxConcurrency: 2 },
    retry: {
      maxAttempts: 1,
      retryableErrorCodes: [],
      backoff: { backoffKind: 'fixed', initialDelayMs: 0, maxDelayMs: 0 },
    },
    budget: {
      run: { maxInvocations: 200 },
      stages: {
        execution: { maxInvocations: 100 },
        evaluation: { maxInvocations: 100 },
      },
      coordinate: {},
      attempt: {},
      providerCostAdmission: {
        admissionMode: 'bounded-overshoot',
        unknownCostMode: 'fail-run',
      },
    },
    evaluation: {
      maxConcurrency: 2,
      retry: {
        maxAttempts: 1,
        retryableErrorCodes: [],
        backoff: { backoffKind: 'fixed', initialDelayMs: 0, maxDelayMs: 0 },
      },
    },
    cache: { executionMode: 'disabled', evaluationMode: 'disabled' },
    evidence: {
      output: 'full',
      trace: 'full',
      evidence: 'full',
      maximumClassification: 'gold',
    },
    failure: { failureMode: 'continue' },
    eventDelivery: {
      writerMode: 'disabled',
      backpressureMode: 'block',
      writerFailureMode: 'ignore',
    },
  };
}

function definition(targetKind) {
  const rag = targetKind === 'rag';
  const metricIds = rag ? ['recall', 'mrr', 'ndcg'] : ['correct'];
  return {
    schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
    dataset: {
      datasetId: `${targetKind}-dataset`,
      samples: [{
        sampleId: 'sample-1',
        input: rag
          ? { query: 'evaluation core' }
          : { prompt: 'answer', answerHint: 'A' },
        expected: rag
          ? { relevantDocumentIds: ['doc-a', 'doc-c'] }
          : { answer: 'A' },
      }],
    },
    targets: ['control', 'treatment'].map((targetId) => ({
      targetId,
      targetKind,
      protocolId: 'omk.invoke/v1',
      executorId: 'same-process',
      versionConstraint: '^1.0.0',
      executionRequirements: {
        systemInstructions: 'not-required',
        workspace: 'not-required',
        mcp: 'not-required',
        mockInterception: 'not-required',
        toolPolicy: 'runtime-default',
        skillDiscovery: 'runtime-default',
      },
      executionControls: {
        defaults: {
          workspace: { workspaceMode: 'not-required' },
          tools: { toolPolicyKind: 'runtime-default' },
        },
        sampleOverrides: [],
      },
    })),
    evaluators: [{
      evaluatorId: 'deterministic',
      evaluatorKind: 'assertion',
      implementationId: 'deterministic/v1',
      versionConstraint: '^1.0.0',
      measurement: {
        instrumentId: 'deterministic-assertion',
        ensembleMemberId: 'deterministic-local',
        replicateGroupId: 'deterministic-primary',
        replicateIndex: 0,
      },
      metricIds,
      inputs: rag
        ? [
          { bindingId: 'ranking', sourceKind: 'output', pointer: '/documents' },
          { bindingId: 'gold', sourceKind: 'expected', pointer: '/relevantDocumentIds' },
        ]
        : [
          { bindingId: 'actual', sourceKind: 'output', pointer: '/answer' },
          { bindingId: 'gold', sourceKind: 'expected', pointer: '/answer' },
        ],
    }],
    metrics: metricIds.map((metricId) => ({
      metricId,
      valueType: rag ? 'numeric' : 'boolean',
      scope: 'sample',
      ...(rag ? { scale: { min: 0, max: 1 } } : {}),
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    })),
    experiment: {
      trials: 1,
      seed: 'host-seed',
      randomizationSlots: [
        { targetId: 'control', randomizationSlotId: 'slot-control' },
        { targetId: 'treatment', randomizationSlotId: 'slot-treatment' },
      ],
      sampling: {
        experimentalUnit: 'sample',
        repeatedMeasures: false,
        resamplingUnit: 'sample',
        estimatorId: 'bootstrap.mean-percentile/v1',
        seedCoupling: 'independent-by-target',
      },
      scheduling: { schedulingKind: 'interleaved' },
    },
    analysisGraph: {
      analysisMode: 'preregistered',
      nodes: [{
        analysisNodeKind: 'reducer',
        nodeId: 'primary-mean',
        implementationId: rag ? 'descriptive.mean/v1' : 'descriptive.rate/v1',
        inputs: [{ inputKind: 'metric-observations', referenceId: metricIds[0] }],
        outputResultId: 'primary-result',
      }],
    },
    comparisons: [{
      comparisonId: 'control-vs-treatment',
      controlTargetId: 'control',
      treatmentTargetIds: ['treatment'],
      metricIds,
    }],
  };
}

async function consume(run) {
  const events = [];
  const consuming = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  const result = await run.result;
  await consuming;
  return { events, result };
}

for (const targetKind of ['function', 'rag']) {
  const host = createHostRuntime(targetKind);
  const run = createEvaluationEngine(host.runtime).start(definition(targetKind), {
    policy: policy(),
    runId: `host-${targetKind}`,
    annotations: { host: 'independent-node-22' },
    eventBufferCapacity: 256,
  });
  const { events, result } = await consume(run);
  assert.equal(result.status, 'completed', JSON.stringify({ targetKind, result }));
  assert.equal(result.report.annotations.host, 'independent-node-22');
  assert.equal(result.artifacts.execution.records.length, 2);
  assert.equal(events.at(-1).eventKind, 'report.materialized');
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index));
  assert.equal(host.executorInputs.some((input) => 'expected' in input), false);
  if (targetKind === 'rag') {
    const observations = result.artifacts.evaluation.records.flatMap((record) => (
      record.evaluationStatus === 'completed' ? record.observations : []
    ));
    assert.deepEqual(
      new Set(observations.map((entry) => entry.metricId)),
      new Set(['recall', 'mrr', 'ndcg']),
      JSON.stringify(result.artifacts.evaluation.records),
    );
  }
}

const cancelledHost = createHostRuntime('function');
const cancelledSignal = new AbortController();
cancelledSignal.abort(new Error('host cancellation'));
const cancelledRun = createEvaluationEngine(cancelledHost.runtime).start(definition('function'), {
  policy: policy(),
  runId: 'host-cancelled',
  signal: cancelledSignal.signal,
  eventBufferCapacity: 256,
});
const cancelled = await consume(cancelledRun);
assert.equal(cancelled.result.status, 'cancelled');
assert.equal(cancelled.result.report.status.evidenceStatus, 'unresolvable');

const stagedHost = createHostRuntime('function');
const stagedEngine = createAdvancedEvaluationEngine(stagedHost.runtime);
const initialDefinition = definition('function');
initialDefinition.decisionPolicy = {
  decisionPolicyId: 'release-gate',
  implementationId: 'progress/v1',
  analysisResultIds: ['primary-result'],
  minimumEvidenceStatus: 'complete',
  parameters: { threshold: 0 },
};
const initialPrepared = await stagedEngine.prepare(initialDefinition, policy());
const executionStages = initialPrepared.stages({ runId: 'advanced-execution' });
const execution = await executionStages.execute().source;
await executionStages.close();
assert.equal(stagedHost.executorInputs.length, 2);

const executionVerification = {
  verifiedProvenanceBundleDigests: new Set([execution.bundle.bundleDigest]),
};
const rescoredDefinition = structuredClone(initialDefinition);
rescoredDefinition.dataset.samples[0].expected = { answer: 'B' };
const rescoredPrepared = await stagedEngine.prepare(rescoredDefinition, policy());
const rescoredExecution = rescoredPrepared.admitExecutionBundle(
  structuredClone(execution.bundle),
  executionVerification,
);
const rescoredStages = rescoredPrepared.stages({ runId: 'advanced-rescore' });
const evaluation = await rescoredStages.evaluate({ execution: rescoredExecution }).source;
const analysis = await rescoredStages.analyze({
  execution: rescoredExecution,
  evaluation,
}).source;
const decision = await rescoredStages.decide({
  execution: rescoredExecution,
  evaluation,
  analysis,
}).source;
const rescoredReport = await rescoredStages.materializeReport({
  execution: rescoredExecution,
  evaluation,
  analysis,
  ...(decision === undefined ? {} : { decision }),
}).result;
await rescoredStages.close();
assert.equal(stagedHost.executorInputs.length, 2);
assert.equal(rescoredReport.bundles[0].bundleDigest, execution.bundle.bundleDigest);

const evaluationVerification = {
  verifiedProvenanceBundleDigests: new Set([evaluation.bundle.bundleDigest]),
  executionSourceTrust: execution.bundle.provenance.trust,
};
const analysisDefinition = structuredClone(rescoredDefinition);
analysisDefinition.analysisGraph.analysisMode = 'exploratory';
const analysisPrepared = await stagedEngine.prepare(analysisDefinition, policy());
const analysisExecution = analysisPrepared.admitExecutionBundle(
  structuredClone(execution.bundle),
  executionVerification,
);
const analysisEvaluation = analysisPrepared.admitEvaluationBundle(
  structuredClone(evaluation.bundle),
  { execution: analysisExecution, verification: evaluationVerification },
);
const evaluatorCallsBeforeReanalysis = stagedHost.evaluatorInputs.length;
const reanalysisStages = analysisPrepared.stages({ runId: 'advanced-reanalysis' });
const reanalysis = await reanalysisStages.analyze({
  execution: analysisExecution,
  evaluation: analysisEvaluation,
}).source;
await reanalysisStages.close();
assert.equal(stagedHost.executorInputs.length, 2);
assert.equal(stagedHost.evaluatorInputs.length, evaluatorCallsBeforeReanalysis);

const decisionDefinition = structuredClone(analysisDefinition);
decisionDefinition.decisionPolicy.parameters = { threshold: 1 };
const decisionPrepared = await stagedEngine.prepare(decisionDefinition, policy());
const decisionExecution = decisionPrepared.admitExecutionBundle(
  structuredClone(execution.bundle),
  executionVerification,
);
const decisionEvaluation = decisionPrepared.admitEvaluationBundle(
  structuredClone(evaluation.bundle),
  { execution: decisionExecution, verification: evaluationVerification },
);
const decisionAnalysis = decisionPrepared.admitAnalysisBundle(
  structuredClone(reanalysis.bundle),
  {
    execution: decisionExecution,
    evaluation: decisionEvaluation,
    verification: {
      verifiedProvenanceBundleDigests: new Set([reanalysis.bundle.bundleDigest]),
      evaluationSourceTrust: evaluation.bundle.provenance.trust,
    },
  },
);
const decisionStages = decisionPrepared.stages({ runId: 'advanced-redecision' });
const redecision = await decisionStages.decide({
  execution: decisionExecution,
  evaluation: decisionEvaluation,
  analysis: decisionAnalysis,
}).source;
assert.notEqual(redecision, undefined);
await decisionStages.close();
assert.equal(stagedHost.executorInputs.length, 2);
assert.equal(stagedHost.evaluatorInputs.length, evaluatorCallsBeforeReanalysis);

const comparabilityPolicy = createComparabilityPolicy({
  schemaVersion: COMPARABILITY_POLICY_SCHEMA_VERSION,
  designMode: 'exact-measurement-design',
  comparisonScope: 'evaluation',
  subjects: [
    { subjectId: 'control', leftTargetId: 'control', rightTargetId: 'control' },
    { subjectId: 'treatment', leftTargetId: 'treatment', rightTargetId: 'treatment' },
  ],
});
const comparability = assessComparability(
  comparabilityPolicy,
  initialPrepared.plan,
  rescoredPrepared.plan,
);
assert.equal(
  comparability.assessment.reasons.some(
    (reason) => reason.reasonCode === 'comparability-design-evaluation-input-mismatch',
  ),
  true,
);

const tamperedExecution = structuredClone(execution.bundle);
tamperedExecution.executionPlanDigest = `sha256:${'0'.repeat(64)}`;
assert.throws(() => rescoredPrepared.admitExecutionBundle(tamperedExecution));
const runtimeTamperedExecution = structuredClone(execution.bundle);
runtimeTamperedExecution.records[0].runtime.fingerprint = `sha256:${'1'.repeat(64)}`;
assert.throws(() => rescoredPrepared.admitExecutionBundle(runtimeTamperedExecution));
const cacheTamperedExecution = structuredClone(execution.bundle);
cacheTamperedExecution.records[0].cache = { cacheStatus: 'replay' };
assert.throws(() => rescoredPrepared.admitExecutionBundle(cacheTamperedExecution));

const alternateStages = initialPrepared.stages({ runId: 'advanced-alternate-execution' });
const alternateExecution = await alternateStages.execute().source;
await alternateStages.close();
assert.throws(() => rescoredPrepared.admitEvaluationBundle(
  structuredClone(evaluation.bundle),
  { execution: alternateExecution },
));

const unverifiedExecution = rescoredPrepared.admitExecutionBundle(
  structuredClone(execution.bundle),
);
const unverifiedEvaluation = rescoredPrepared.admitEvaluationBundle(
  structuredClone(evaluation.bundle),
  { execution: unverifiedExecution },
);
const unverifiedAnalysis = rescoredPrepared.admitAnalysisBundle(
  structuredClone(analysis.bundle),
  { execution: unverifiedExecution, evaluation: unverifiedEvaluation },
);
const unverifiedStages = rescoredPrepared.stages({ runId: 'advanced-unverified-decision' });
const unverifiedDecision = await unverifiedStages.decide({
  execution: unverifiedExecution,
  evaluation: unverifiedEvaluation,
  analysis: unverifiedAnalysis,
}).source;
await unverifiedStages.close();
assert.equal(unverifiedDecision.result.decisionStatus, 'not-decided');
assert.equal(
  unverifiedDecision.result.reasonCodes.includes(
    'decision-execution-provenance-indeterminate',
  ),
  true,
);
assert.equal(EVALUATION_CORE_JSON_SCHEMA_FILES.length, 21);
const executionSchemaUrl = resolveEvaluationCoreJsonSchema('execution-bundle.schema.json');
assert.equal(executionSchemaUrl.pathname.endsWith('/execution-bundle.schema.json'), true);
assert.throws(() => resolveEvaluationCoreJsonSchema('../package.json'));
