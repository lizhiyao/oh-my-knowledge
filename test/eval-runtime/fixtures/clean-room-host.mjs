import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  EvaluationEventConsumptionError,
  checkExecutor,
  evaluate,
  prepareEvaluation,
} from 'oh-my-knowledge/eval-runtime';

const retryAttempts = [];
const executor = {
  executorId: 'clean-room.json-host/v1',
  version: '1.0.0',
  schemas: { input: z.string(), config: z.undefined(), output: z.string() },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: {
      trace: 'unsupported',
      usage: 'required',
      providerCost: { reporting: 'optional' },
    },
  },
  fingerprintFacets: { revision: 'clean-room-one' },
  async execute({ input, attemptNumber, signal }) {
    if (input === 'retry') {
      retryAttempts.push(attemptNumber);
      if (attemptNumber === 1) {
        return { errorCode: 'clean-room-retryable', usage: { inputTokens: 1 } };
      }
    }
    if (input === 'failure') {
      return { errorCode: 'clean-room-expected-failure', usage: { inputTokens: 1 } };
    }
    if (input === 'cancellation') {
      await new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
    return {
      output: 'expected',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        providerCost: { amount: 0.001, currency: 'USD', reportedByProvider: true },
      },
    };
  },
};

const variant = {
  variantId: 'prompt-v2',
  artifact: {
    name: 'prompt-v2',
    kind: 'prompt',
    source: 'inline',
    content: 'Return expected.',
  },
  execution: { executor },
};

const evaluationInput = (overrides = {}) => ({
  dataset: {
    datasetId: 'clean-room-runner',
    samples: ['one', 'two'].map((sampleId) => ({
      sampleId,
      input: 'success',
      expected: 'expected',
    })),
  },
  variants: [{
    variantId: 'baseline',
    artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
    execution: { executor },
  }, variant],
  evaluators: [{ evaluatorKind: 'exact-match' }],
  comparisons: [{
    comparisonId: 'baseline-vs-prompt-v2',
    controlVariantId: 'baseline',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct'],
  }],
  analyses: [{
    analysisId: 'baseline-vs-prompt-v2-correct',
    analysisKind: 'comparison-interval', statistic: 'mean-difference',
    comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
    metricId: 'correct',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
  }],
  decision: {
    decisionKind: 'analysis',
    analysisId: 'baseline-vs-prompt-v2-correct',
  },
  experiment: { seed: 'clean-room-seed', sampling: { samplingKind: 'paired' } },
  policy: {
    execution: { maxConcurrency: 1 },
    evaluation: { maxConcurrency: 1 },
    budget: {
      run: { maxInvocations: 50, maxWallClockMs: 60_000 },
      execution: {
        maxActiveDurationMs: 30_000,
        maxProviderCost: { amount: 0.01, currency: 'USD' },
      },
      coordinate: { maxInvocations: 4 },
      onUnreportedProviderCost: 'fail-run',
    },
  },
  ...overrides,
});

const evaluation = (overrides = {}, options = {}) => evaluate(
  evaluationInput(overrides),
  { runId: 'clean-room-evaluate', ...options },
);

let preparedTargetCalls = 0;
const preparationInput = evaluationInput({
  variants: evaluationInput().variants.map((candidate) => ({
    ...candidate,
    execution: {
      executor: {
        ...candidate.execution.executor,
        async execute(invocation) {
          preparedTargetCalls += 1;
          return candidate.execution.executor.execute(invocation);
        },
      },
    },
  })),
});
const prepared = await prepareEvaluation(preparationInput);
assert.equal(preparedTargetCalls, 0);
assert.ok(Object.isFrozen(prepared.plan));
assert.equal(prepared.planDigest, prepared.plan.digests.runContractDigest);
assert.equal(prepared.estimatedWork.executionCoordinates, 4);
assert.equal(prepared.estimatedWork.evaluationCoordinates, 4);
assert.equal(prepared.estimatedWork.plannedInvocations, 8);
assert.deepEqual(
  new Set(prepared.resolvedRuntimes.map(({ runtimeKind }) => runtimeKind)),
  new Set(['executor', 'evaluator', 'analysis-node', 'missing-policy', 'decision-policy']),
);

preparationInput.dataset.samples[0].input = 'changed-after-prepare';
const preparedResult = await prepared.run({ runId: 'clean-room-prepared' });
assert.equal(preparedResult.status, 'completed');
assert.equal(preparedResult.runId, 'clean-room-prepared');
assert.equal(preparedTargetCalls, 4);
assert.equal(preparedResult.definition.dataset.samples[0].input, 'success');

const workspaceDescriptor = {
  resourceId: 'clean-room-workspace',
  digest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'application/vnd.omk.workspace-tree',
  classification: 'sensitive',
  size: 8,
};
const workspaceRoots = [];
const closedWorkspaceRoots = [];
const persistedContent = new Map();
let persistedContentWrites = 0;
let persistedContentReads = 0;
const contentStore = {
  async put(request) {
    persistedContentWrites += 1;
    persistedContent.set(request.digest, structuredClone(request));
    return { digest: request.digest, mediaType: request.mediaType };
  },
};
const contentResolver = {
  async resolve(descriptor) {
    persistedContentReads += 1;
    const stored = persistedContent.get(descriptor.digest);
    assert.ok(stored);
    return {
      value: stored.value,
      classification: stored.classification,
      mediaType: stored.mediaType,
    };
  },
};
const workspaceExecutor = {
  executorId: 'clean-room.workspace-agent/v1',
  version: '1.0.0',
  schemas: { input: z.string(), config: z.undefined(), output: z.string() },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    toolPolicy: 'allow-list',
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  workspaceProvider: {
    providerId: 'clean-room.temp-workspace/v1',
    version: '1.0.0',
    fingerprintFacets: { source: 'verified-fixture/v1' },
    async open({ descriptor }) {
      assert.deepEqual(descriptor, workspaceDescriptor);
      const root = await mkdtemp(join(tmpdir(), 'omk-clean-room-workspace-'));
      workspaceRoots.push(root);
      await writeFile(join(root, 'answer.txt'), 'workspace-answer', 'utf8');
      return {
        root,
        async close() {
          await rm(root, { recursive: true, force: true });
          closedWorkspaceRoots.push(root);
        },
      };
    },
  },
  async execute({ workspace, allowedTools }) {
    assert.ok(workspace);
    assert.deepEqual(workspace.descriptor, workspaceDescriptor);
    assert.deepEqual(allowedTools, ['Read']);
    return { output: await readFile(join(workspace.root, 'answer.txt'), 'utf8') };
  },
};
const workspaceEvaluation = await evaluate({
  dataset: {
    datasetId: 'clean-room-workspace',
    samples: [{ sampleId: 'workspace', input: 'read', expected: 'workspace-answer' }],
  },
  variants: [{
    variantId: 'workspace-agent',
    artifact: {
      name: 'workspace-agent', kind: 'agent', source: 'inline', content: 'Read the workspace.',
    },
    execution: {
      executor: workspaceExecutor,
      workspace: workspaceDescriptor,
      allowedTools: ['Read'],
    },
  }],
  evaluators: [{ evaluatorKind: 'exact-match' }],
  comparisons: [],
  analyses: [{
    analysisId: 'workspace-correct', analysisKind: 'summary', statistic: 'rate',
    variantId: 'workspace-agent', metricId: 'correct',
  }],
  experiment: { seed: 'clean-room-workspace', sampling: { samplingKind: 'solo' } },
  policy: { evidence: { output: 'reference', trace: 'none' } },
  infrastructure: { contentStore, contentResolver },
}, { runId: 'clean-room-workspace' });
assert.equal(workspaceEvaluation.status, 'completed');
assert.equal(workspaceEvaluation.analysisResults['workspace-correct'].value, 1);
assert.equal(workspaceEvaluation.artifacts.execution.records[0].output.contentKind, 'descriptor');
assert.equal(persistedContentWrites, 1);
assert.equal(persistedContentReads, 1);
assert.deepEqual(closedWorkspaceRoots, workspaceRoots);
assert.equal(JSON.stringify(workspaceEvaluation).includes(tmpdir()), false);
for (const root of workspaceRoots) {
  await assert.rejects(access(root));
}

const withoutObserver = await evaluation();
assert.equal(withoutObserver.status, 'completed');
assert.equal(withoutObserver.runId, 'clean-room-evaluate');
assert.equal(withoutObserver.definition.dataset.datasetId, 'clean-room-runner');
assert.deepEqual(withoutObserver.policy.budget.run, {
  maxInvocations: 50,
  maxWallClockMs: 60_000,
});
assert.deepEqual(withoutObserver.policy.budget.stages.execution, {
  maxActiveDurationMs: 30_000,
  maxProviderCost: { amount: 0.01, currency: 'USD' },
});
assert.equal(withoutObserver.policy.budget.providerCostAdmission.admissionMode, 'bounded-overshoot');
assert.equal(withoutObserver.policy.budget.providerCostAdmission.unknownCostMode, 'fail-run');
assert.equal(withoutObserver.report.budgetSummary.summaryStatus, 'within-budget');

const withRetry = await evaluation({
  dataset: {
    datasetId: 'clean-room-retry',
    samples: [{ sampleId: 'retry', input: 'retry', expected: 'expected' }],
  },
  policy: {
    execution: {
      maxConcurrency: 1,
      retry: {
        maxAttempts: 2,
        retryableErrorCodes: ['clean-room-retryable'],
        backoff: { backoffKind: 'none' },
      },
    },
    evaluation: { maxConcurrency: 1 },
    failure: { failureMode: 'fail-fast' },
  },
}, { runId: 'clean-room-retry' });
assert.equal(withRetry.status, 'completed');
assert.deepEqual(retryAttempts, [1, 2, 1, 2]);
assert.ok(withRetry.artifacts.execution.records.every((record) => record.attempts.length === 2));

const lengthEvaluator = {
  evaluatorKind: 'custom',
  evaluatorId: 'clean-room-length',
  instrumentId: 'clean-room-length-v1',
  metric: {
    metricId: 'output-length',
    valueType: 'numeric',
    scale: { min: 0, max: 20 },
    direction: 'lower-is-better',
    missingPolicyId: 'exclude/v1',
  },
  bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
  implementation: {
    implementationId: 'clean-room.length/v1',
    version: '1.0.0',
    schemas: {
      bindings: z.object({ actual: z.string() }).strict(),
      value: z.number(),
      fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
    },
    fingerprintFacets: { revision: 'clean-room-one' },
    evaluate({ bindings }) {
      return { resultKind: 'score', value: bindings.actual.length };
    },
  },
};

const customEvaluation = await evaluation({
  dataset: {
    datasetId: 'clean-room-analysis-presets',
    analysisCohorts: [{
      cohortId: 'smoke',
      cohortSetId: 'release-slice',
      cohortSetKind: 'cohort',
      classification: 'public',
      disclosure: 'identity-only',
    }],
    samples: ['one', 'two'].map((sampleId, index) => ({
      sampleId,
      input: 'success',
      expected: 'expected',
      ...(index === 0 ? { analysis: { memberships: [{ cohortId: 'smoke' }] } } : {}),
    })),
  },
  evaluators: [{ evaluatorKind: 'exact-match' }, lengthEvaluator],
  comparisons: [{
    comparisonId: 'baseline-vs-prompt-v2',
    controlVariantId: 'baseline',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct', 'output-length'],
  }],
  analyses: [{
    analysisId: 'baseline-mean-length',
    analysisKind: 'summary', statistic: 'mean',
    variantId: 'baseline', metricId: 'output-length',
  }, {
    analysisId: 'prompt-v2-mean-length',
    analysisKind: 'summary', statistic: 'mean',
    variantId: 'prompt-v2', metricId: 'output-length',
  }, {
    analysisId: 'prompt-v2-smoke-p50-length',
    analysisKind: 'summary', statistic: 'quantile', probability: 0.5,
    variantId: 'prompt-v2', metricId: 'output-length',
    cohortFilter: { includeCohortIds: ['smoke'] },
  }, {
    analysisId: 'baseline-vs-prompt-v2-length',
    analysisKind: 'comparison-interval', statistic: 'mean-difference',
    comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
    metricId: 'output-length',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
  }, {
    analysisId: 'paired-release-family',
    analysisKind: 'comparison-family', statistic: 'mean-difference',
    members: [{
      analysisId: 'paired-correct-member',
      comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
      metricId: 'correct',
    }, {
      analysisId: 'paired-length-member',
      comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
      metricId: 'output-length',
    }],
    confidence: {
      method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 100,
    },
  }, {
    analysisId: 'prompt-v2-overall-quality',
    analysisKind: 'composite-quality-interval',
    compositeMetricId: 'overall-quality',
    variantId: 'prompt-v2',
    components: [
      { metricId: 'correct', weight: 0.5 },
      { metricId: 'output-length', weight: 0.5 },
    ],
    aggregation: { method: 'weighted-mean', missing: 'require-complete' },
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
  }, {
    analysisId: 'paired-overall-quality-difference',
    analysisKind: 'composite-comparison-interval',
    compositeMetricId: 'overall-quality',
    comparisonId: 'baseline-vs-prompt-v2',
    treatmentVariantId: 'prompt-v2',
    components: [
      { metricId: 'correct', weight: 0.5 },
      { metricId: 'output-length', weight: 0.5 },
    ],
    aggregation: { method: 'weighted-mean', missing: 'require-complete' },
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
  }],
  decision: {
    decisionKind: 'comparison-family',
    analysisId: 'paired-release-family',
    rule: 'all',
    criteria: [{
      analysisId: 'paired-correct-member', minimumEffect: -100, maximumEffect: 100,
    }, {
      analysisId: 'paired-length-member', minimumEffect: -100, maximumEffect: 100,
    }],
  },
}, { runId: 'clean-room-custom-evaluator' });
assert.equal(customEvaluation.status, 'completed');
assert.equal(customEvaluation.artifacts.analysis.records.length, 9);
assert.equal(customEvaluation.analysisResults['baseline-mean-length'].value, 8);
assert.equal(customEvaluation.analysisResults['prompt-v2-mean-length'].value, 8);
assert.equal(customEvaluation.analysisResults['prompt-v2-smoke-p50-length'].value, 8);
assert.equal(customEvaluation.analysisResults['paired-correct-member'].value.confidenceLevel, 0.975);
assert.equal(customEvaluation.analysisResults['paired-release-family'].value.familySize, 2);
assert.equal(customEvaluation.analysisResults['prompt-v2-overall-quality'].value.estimate, 0.8);
assert.equal(customEvaluation.analysisResults['prompt-v2-overall-quality'].value.unitCount, 2);
assert.equal(
  customEvaluation.analysisResults['paired-overall-quality-difference'].value.estimate,
  0,
);
assert.equal(
  customEvaluation.analysisResults['paired-overall-quality-difference'].value.unitCount,
  2,
);
assert.equal(customEvaluation.artifacts.decision.decisionStatus, 'decided');
assert.equal(customEvaluation.artifacts.decision.verdict, 'RELEASE');
assert.ok(customEvaluation.artifacts.evaluation.records.every((record) => (
  record.evaluationStatus === 'completed'
  && record.observations[0]?.observationStatus === 'observed'
)));

const retrievalInvocations = [];
const retrievalExecutor = {
  executorId: 'clean-room.retriever/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ query: z.string() }).strict(),
    config: z.undefined(),
    output: z.object({ documents: z.array(z.string()) }).strict(),
  },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  fingerprintFacets: { revision: 'clean-room-retrieval-one' },
  async execute(invocation) {
    retrievalInvocations.push(structuredClone(invocation));
    return {
      output: {
        documents: invocation.input.query === 'one' ? ['doc-x', 'doc-a'] : ['doc-b'],
      },
    };
  },
};
const retrievalEvaluation = await evaluate({
  dataset: {
    datasetId: 'clean-room-retrieval',
    samples: [{
      sampleId: 'retrieval-one',
      input: { query: 'one' },
      expected: { relevantDocumentIds: ['doc-a'] },
    }, {
      sampleId: 'retrieval-two',
      input: { query: 'two' },
      expected: { relevantDocumentIds: ['doc-b'] },
    }],
  },
  variants: [{
    variantId: 'retriever-v1',
    artifact: {
      name: 'retriever-v1', kind: 'workflow', source: 'inline', content: 'Retrieve documents.',
    },
    execution: { executor: retrievalExecutor },
  }],
  evaluators: [{
    evaluatorKind: 'retrieval',
    evaluatorId: 'retrieval-quality',
    cutoff: 3,
    ranking: { source: 'output', pointer: '/documents' },
    relevantDocumentIdsPointer: '/relevantDocumentIds',
    metricIds: {
      recallAtK: 'recall-at-3',
      precisionAtK: 'precision-at-3',
      reciprocalRankAtK: 'reciprocal-rank-at-3',
      ndcgAtK: 'ndcg-at-3',
    },
  }],
  comparisons: [],
  analyses: [{
    analysisId: 'mean-reciprocal-rank-at-3',
    analysisKind: 'summary',
    statistic: 'mean',
    variantId: 'retriever-v1',
    metricId: 'reciprocal-rank-at-3',
  }],
  experiment: { seed: 'clean-room-retrieval', sampling: { samplingKind: 'solo' } },
  policy: {},
}, { runId: 'clean-room-retrieval' });
assert.equal(retrievalEvaluation.status, 'completed');
assert.equal(retrievalEvaluation.definition.metrics.length, 4);
assert.equal(retrievalEvaluation.analysisResults['mean-reciprocal-rank-at-3'].value, 0.75);
assert.equal(JSON.stringify(retrievalInvocations).includes('relevantDocumentIds'), false);

const trajectoryInvocations = [];
const trajectoryExecutor = {
  executorId: 'clean-room.agent/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ request: z.string() }).strict(),
    config: z.undefined(),
    output: z.string(),
    trace: z.object({
      schemaVersion: z.literal('omk.source-neutral-trace/v2'),
      turns: z.array(z.json()),
      toolCalls: z.array(z.object({
        tool: z.string(), input: z.json(), output: z.json(), success: z.boolean(),
        status: z.enum(['success', 'failure', 'cancelled', 'unknown']),
        statusSource: z.enum(['runtime', 'tool-output', 'inferred', 'unknown']),
      }).strict()),
      numTurns: z.number().int().nonnegative(),
      fullNumTurns: z.number().int().nonnegative(),
      numSubAgents: z.number().int().nonnegative(),
    }).strict(),
  },
  outputClassification: 'public',
  traceClassification: 'sensitive',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'required', usage: 'optional' },
  },
  fingerprintFacets: { revision: 'clean-room-agent-one' },
  async execute(invocation) {
    trajectoryInvocations.push(structuredClone(invocation));
    return {
      output: 'done',
      trace: {
        schemaVersion: 'omk.source-neutral-trace/v2',
        turns: [],
        toolCalls: [{
          tool: 'List', input: null, output: null, success: true,
          status: 'success', statusSource: 'runtime',
        }, {
          tool: 'Search', input: null, output: null, success: false,
          status: 'failure', statusSource: 'runtime',
        }, {
          tool: 'Read', input: null, output: null, success: true,
          status: 'success', statusSource: 'runtime',
        }],
        numTurns: 1,
        fullNumTurns: 1,
        numSubAgents: 0,
      },
    };
  },
};
const trajectoryEvaluation = await evaluate({
  dataset: {
    datasetId: 'clean-room-tool-trajectory',
    samples: [{
      sampleId: 'research-policy',
      input: { request: 'Research the policy.' },
      expected: { expectedToolNames: ['Search', 'Read'] },
    }],
  },
  variants: [{
    variantId: 'agent-v1',
    artifact: {
      name: 'agent-v1', kind: 'agent', source: 'inline', content: 'Research with tools.',
    },
    execution: { executor: trajectoryExecutor },
  }],
  evaluators: [{
    evaluatorKind: 'tool-trajectory',
    evaluatorId: 'tool-trajectory',
    metricId: 'tool-trajectory-match',
    tracePointer: '',
    expectedToolNamesPointer: '/expectedToolNames',
    match: 'contains-in-order',
  }],
  comparisons: [],
  analyses: [{
    analysisId: 'tool-trajectory-rate',
    analysisKind: 'summary', statistic: 'rate',
    variantId: 'agent-v1', metricId: 'tool-trajectory-match',
  }],
  experiment: { seed: 'clean-room-tool-trajectory', sampling: { samplingKind: 'solo' } },
  policy: {},
}, { runId: 'clean-room-tool-trajectory' });
assert.equal(trajectoryEvaluation.status, 'completed');
assert.equal(trajectoryEvaluation.analysisResults['tool-trajectory-rate'].value, 1);
assert.equal(JSON.stringify(trajectoryInvocations).includes('expectedToolNames'), false);
assert.equal(
  Object.hasOwn(trajectoryEvaluation.artifacts.evaluation.records[0].observations[0], 'evidence'),
  false,
);

const openedSessions = [];
const sessionExecutor = {
  protocol: 'session',
  executorId: 'clean-room.session-agent/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ task: z.string() }).strict(),
    config: z.object({ answer: z.string() }).strict(),
    output: z.string(),
  },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  fingerprintFacets: { revision: 'clean-room-session-one' },
  async openSession(context) {
    const observed = {
      runId: context.runId,
      trialId: context.trialId,
      context: structuredClone(context),
      attempts: [],
      closes: 0,
    };
    openedSessions.push(observed);
    return {
      async execute(attempt) {
        observed.attempts.push({
          attemptId: attempt.attemptId,
          attemptNumber: attempt.attemptNumber,
        });
        if (attempt.attemptNumber === 1) return { errorCode: 'temporary-session-failure' };
        return { output: context.config.answer };
      },
      close() { observed.closes += 1; },
    };
  },
};
const sessionEvaluation = await evaluate({
  dataset: {
    datasetId: 'clean-room-session-agent',
    samples: [{
      sampleId: 'session-agent-one',
      input: { task: 'Research the policy.' },
      expected: 'done',
      evaluationContext: { privateJudgeContext: 'not-for-session' },
    }],
  },
  variants: [{
    variantId: 'session-agent',
    artifact: {
      name: 'session-agent', kind: 'agent', source: 'inline', content: 'Research carefully.',
    },
    execution: { executor: sessionExecutor, config: { answer: 'done' } },
  }],
  evaluators: [{ evaluatorKind: 'exact-match' }],
  comparisons: [],
  analyses: [{
    analysisId: 'session-agent-correct',
    analysisKind: 'summary', statistic: 'rate',
    variantId: 'session-agent', metricId: 'correct',
  }],
  experiment: { seed: 'clean-room-session-agent', sampling: { samplingKind: 'solo' } },
  policy: {
    execution: {
      retry: {
        maxAttempts: 2,
        retryableErrorCodes: ['temporary-session-failure'],
        backoff: { backoffKind: 'none' },
      },
    },
  },
}, { runId: 'clean-room-session-agent' });
assert.equal(sessionEvaluation.status, 'completed');
assert.equal(sessionEvaluation.definition.targets[0].protocolId, 'omk.session/v1');
assert.equal(sessionEvaluation.analysisResults['session-agent-correct'].value, 1);
assert.equal(openedSessions.length, 1);
assert.equal(openedSessions[0].closes, 1);
assert.deepEqual(openedSessions[0].attempts.map((attempt) => attempt.attemptNumber), [1, 2]);
assert.equal(new Set(openedSessions[0].attempts.map((attempt) => attempt.attemptId)).size, 2);
assert.equal(JSON.stringify(openedSessions[0].context).includes('not-for-session'), false);

const independent = await evaluation({
  dataset: {
    datasetId: 'clean-room-independent',
    samples: ['one', 'two', 'three', 'four'].map((sampleId) => ({
      sampleId,
      input: 'success',
      expected: 'expected',
    })),
  },
  evaluators: [{ evaluatorKind: 'exact-match' }, lengthEvaluator],
  comparisons: [{
    comparisonId: 'baseline-vs-prompt-v2',
    controlVariantId: 'baseline',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct', 'output-length'],
  }],
  analyses: [{
    analysisId: 'independent-release-family',
    analysisKind: 'comparison-family', statistic: 'mean-difference',
    members: [{
      analysisId: 'independent-correct-member',
      comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
      metricId: 'correct',
    }, {
      analysisId: 'independent-length-member',
      comparisonId: 'baseline-vs-prompt-v2', treatmentVariantId: 'prompt-v2',
      metricId: 'output-length',
    }],
    confidence: {
      method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 100,
    },
  }],
  decision: undefined,
  experiment: {
    seed: 'clean-room-independent-seed',
    sampling: {
      samplingKind: 'independent',
      allocations: [
        { variantId: 'baseline', weight: 1 },
        { variantId: 'prompt-v2', weight: 1 },
      ],
      minimumSamplesPerVariant: 2,
      minimumSamplesPerVariantPerStratum: 1,
    },
  },
}, { runId: 'clean-room-independent' });
assert.equal(independent.status, 'completed');
assert.equal(independent.artifacts.execution.records.length, 4);
assert.equal(
  new Set(independent.artifacts.execution.records.map((record) => record.sampleId)).size,
  4,
);
assert.equal(independent.artifacts.analysis.records[0].analysisStatus, 'completed');
assert.equal(
  independent.analysisResults['independent-correct-member'].implementation.implementationId,
  'bootstrap.unpaired-difference-percentile/v1',
);
assert.equal(independent.analysisResults['independent-release-family'].value.familySize, 2);

const clustered = await evaluate({
  dataset: {
    datasetId: 'clean-room-clustered',
    samples: ['a-1', 'a-2', 'b-1', 'b-2'].map((sampleId) => ({
      sampleId,
      input: 'success',
      expected: 'expected',
      executionContext: { cluster: sampleId.slice(0, 1) },
    })),
  },
  variants: [variant],
  evaluators: [{ evaluatorKind: 'exact-match' }],
  comparisons: [],
  analyses: [{
    analysisId: 'clustered-correctness',
    analysisKind: 'quality-interval', statistic: 'mean',
    variantId: 'prompt-v2', metricId: 'correct',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 64 },
  }],
  experiment: {
    seed: 'clean-room-cluster-seed',
    sampling: { samplingKind: 'solo', clusterKey: '/executionContext/cluster' },
  },
  policy: {}
}, {
  runId: 'clean-room-clustered'
});
assert.equal(clustered.status, 'completed');
assert.equal(clustered.analysisResults['clustered-correctness'].value.unitCount, 2);

const sequences = [];
const withSlowObserver = await evaluation({}, {
  runId: 'clean-room-slow-observer',
  eventBufferCapacity: 1,
  async onEvent(event) {
    await delay();
    sequences.push(event.sequence);
  },
});
assert.equal(withSlowObserver.status, 'completed');
assert.ok(sequences.length > 0);
assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]));

const observerSecret = 'private progress sink payload';
let observerFailure;
try {
  await evaluation({}, {
    runId: 'clean-room-observer-failure',
    eventBufferCapacity: 1,
    onEvent() {
      throw { secret: observerSecret };
    },
  });
} catch (error) {
  observerFailure = error;
}
assert.ok(observerFailure instanceof EvaluationEventConsumptionError);
assert.equal(observerFailure.runResult.status, 'completed');
assert.equal(observerFailure.runResult.definition.dataset.datasetId, 'clean-room-runner');
assert.equal(observerFailure.runResult.policy.execution.maxConcurrency, 1);
assert.equal(observerFailure.cause, undefined);
assert.equal(JSON.stringify(observerFailure).includes(observerSecret), false);

const conformance = await checkExecutor({
  variant,
  success: { input: 'success', expected: 'expected' },
  failure: { input: 'failure', expectedErrorCode: 'clean-room-expected-failure' },
  cancellation: { input: 'cancellation' },
});
assert.equal(conformance.conformant, true, JSON.stringify(conformance.checks));
assert.ok(conformance.checks.every((check) => check.checkStatus === 'passed'));
