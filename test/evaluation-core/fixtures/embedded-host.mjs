import assert from 'node:assert/strict';
import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  MEASUREMENT_POLICY_SCHEMA_VERSION,
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  createEvaluationEngine,
  digestCanonicalJson,
  resolveBuiltinAnalysisRuntime,
} from 'oh-my-knowledge';

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
  return {
    executorInputs,
    runtime: {
      preparation: {
        resolveExecutor() {
          return { identity: executorRuntime, satisfiesVersionConstraint: true };
        },
        resolveEvaluator() {
          return { identity: evaluatorRuntime, satisfiesVersionConstraint: true };
        },
        resolveAnalysis(requirement) {
          const resolution = resolveBuiltinAnalysisRuntime(requirement);
          if (resolution === undefined) throw new Error('Unknown built-in Analysis Runtime.');
          return resolution;
        },
      },
      executors: new Map([['same-process', executor]]),
      evaluators: new Map([['deterministic/v1', evaluator]]),
      clock: new HostClock(),
      schemaValidators,
      analysisNodes: createBuiltinAnalysisNodes(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
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
    budget: { maxTargetInvocations: 100 },
    evaluation: {
      maxConcurrency: 2,
      retry: {
        maxAttempts: 1,
        retryableErrorCodes: [],
        backoff: { backoffKind: 'fixed', initialDelayMs: 0, maxDelayMs: 0 },
      },
      budget: { maxEvaluatorInvocations: 100 },
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
    })),
    evaluators: [{
      evaluatorId: 'deterministic',
      evaluatorKind: 'assertion',
      implementationId: 'deterministic/v1',
      versionConstraint: '^1.0.0',
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
