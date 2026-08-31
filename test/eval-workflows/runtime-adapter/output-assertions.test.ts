import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  EvaluationDefinition,
  JsonValue,
  MeasurementPolicy,
  RuntimeIdentity,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  RuntimeIdentitySchema,
  digestCanonicalJson,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  prepareEvaluationPlan,
  type PreparationRuntime,
} from '../../../src/evaluation-core/compiler/index.js';
import {
  executeRunPlanSource,
  InMemoryRuntimeEventSequencer,
  type ExecutionClock,
  type ExecutionExecutor,
} from '../../../src/evaluation-core/execution/index.js';
import {
  evaluateExecutionBundle,
  type EvaluationEvaluator,
} from '../../../src/evaluation-core/evaluation/index.js';
import {
  createSameProcessEvaluatorAdapter,
  createBuiltinOmkScoringBindingFactories,
  createOutputAssertionEvaluatorImplementation,
  OUTPUT_ASSERTION_BINDINGS,
  OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION,
  OUTPUT_ASSERTION_EVALUATOR_IDENTITY,
  OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
} from '../../../src/eval-workflows/runtime-adapter/index.js';
import { SYNC_ASSERTION_TYPE_NAMES } from '../../../src/shared/assertion-types.js';
import {
  EXECUTION_AWARE_SYNC_ASSERTION_TYPE_NAMES,
  OUTPUT_ONLY_SYNC_ASSERTION_TYPE_NAMES,
  createIsolatedDeterministicAssertionEvaluator,
} from '../../../src/shared/assertions/deterministic.js';
import type { Assertion, AssertionDetail } from '../../../src/types/index.js';
import { testRuntime, validDefinition, validPolicy } from '../../evaluation-core/compiler/fixtures.js';

interface ScoringFixture {
  deterministicAssertions: {
    output: string;
    assertions: Assertion[];
    expected: { details: AssertionDetail[] };
  };
}

const scoringFixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../fixtures/evaluation-core/scoring-equivalence-v1.json',
  import.meta.url,
)), 'utf8')) as ScoringFixture;

const OUTPUT_METRIC_IDS = [
  'contains-hello',
  'short-enough',
  'contains-missing',
  'fact-set',
] as const;

const VALID_CRITERIA: JsonValue[] = scoringFixture.deterministicAssertions.assertions
  .slice(0, OUTPUT_METRIC_IDS.length)
  .map((assertion, index) => ({
    criterionId: OUTPUT_METRIC_IDS[index],
    metricId: OUTPUT_METRIC_IDS[index],
    assertion: structuredClone(assertion) as unknown as JsonValue,
  }));

class DeterministicClock implements ExecutionClock {
  #now = 0;

  monotonicNow(): number {
    const value = this.#now;
    this.#now += 1;
    return value;
  }

  timestamp(): string {
    return '2026-08-31T00:00:00.000Z';
  }

  async sleep(_delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
}

function definitionWithCriteria(criteria: readonly JsonValue[]): EvaluationDefinition {
  const definition = validDefinition();
  definition.dataset.samples[0].evaluationContext = {
    outputAssertions: {
      schemaVersion: OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION,
      criteria: [...criteria],
    },
  };
  definition.evaluators = [{
    evaluatorId: 'output-assertions',
    evaluatorKind: 'assertion',
    implementationId: OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
    measurement: {
      instrumentId: 'omk-output-assertions',
      ensembleMemberId: 'deterministic-local',
      replicateGroupId: 'deterministic-primary',
      replicateIndex: 0,
    },
    metricIds: [...OUTPUT_METRIC_IDS, 'not-applicable'],
    inputs: [
      { bindingId: OUTPUT_ASSERTION_BINDINGS.actual, sourceKind: 'output', pointer: '/answer' },
      {
        bindingId: OUTPUT_ASSERTION_BINDINGS.criteria,
        sourceKind: 'evaluation-context',
        pointer: '/outputAssertions',
      },
    ],
  }];
  definition.metrics = definition.evaluators[0].metricIds.map((metricId) => ({
    metricId,
    valueType: 'boolean' as const,
    scope: 'sample' as const,
    direction: 'higher-is-better' as const,
    missingPolicyId: 'exclude/v1',
  }));
  definition.analysisGraph.nodes = [{
    analysisNodeKind: 'reducer',
    nodeId: 'contains-rate',
    implementationId: 'descriptive.rate/v1',
    inputs: [{ inputKind: 'metric-observations', referenceId: 'contains-hello' }],
    outputResultId: 'contains-rate',
  }];
  definition.comparisons[0].metricIds = ['contains-hello'];
  definition.decisionPolicy = {
    decisionPolicyId: 'release-gate',
    implementationId: 'progress/v1',
    analysisResultIds: ['contains-rate'],
    minimumEvidenceStatus: 'complete',
    parameters: { threshold: 0 },
  };
  return definition;
}

function policy(maximumClassification: 'public' | 'gold' = 'gold'): MeasurementPolicy {
  const value = validPolicy();
  value.retry.maxAttempts = 1;
  value.evaluation.retry.maxAttempts = 1;
  value.evidence.trace = 'none';
  value.evidence.evidence = 'full';
  value.evidence.maximumClassification = maximumClassification;
  return value;
}

function preparationRuntime(): PreparationRuntime {
  const base = testRuntime();
  return {
    ...base,
    resolveEvaluator() {
      return {
        identity: OUTPUT_ASSERTION_EVALUATOR_IDENTITY,
        satisfiesVersionConstraint: true,
      };
    },
  };
}

function runtimeIdentity(
  plan: Awaited<ReturnType<typeof prepareEvaluationPlan>>,
  runtimeKind: 'executor' | 'evaluator',
  referenceId: string,
): RuntimeIdentity {
  const stage = runtimeKind === 'executor' ? plan.execution : plan.evaluation;
  const runtime = stage.runtimes.find((candidate) => (
    candidate.runtimeKind === runtimeKind && candidate.referenceId === referenceId
  ));
  if (runtime === undefined) throw new Error(`Missing ${runtimeKind} runtime ${referenceId}`);
  return RuntimeIdentitySchema.parse(structuredClone(runtime.identity));
}

function executor(
  plan: Awaited<ReturnType<typeof prepareEvaluationPlan>>,
): ExecutionExecutor {
  return {
    identity: runtimeIdentity(plan, 'executor', 'control'),
    async openRun() {
      return {
        async openTrial() {
          return {
            async execute() {
              return {
                output: {
                  value: { answer: scoringFixture.deterministicAssertions.output },
                  classification: 'public' as const,
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
}

function instrumentLifecycle(
  port: EvaluationEvaluator,
  faults: { recordDispose?: boolean } = {},
) {
  const counts = {
    runOpens: 0,
    runDisposals: 0,
    recordOpens: 0,
    recordDisposals: 0,
    evaluations: 0,
  };
  const instrumented: EvaluationEvaluator = {
    identity: port.identity,
    async openRun(context) {
      counts.runOpens += 1;
      const run = await port.openRun(context);
      return {
        async openRecord(recordContext) {
          counts.recordOpens += 1;
          const record = await run.openRecord(recordContext);
          return {
            async evaluate(attempt) {
              counts.evaluations += 1;
              return record.evaluate(attempt);
            },
            async dispose() {
              counts.recordDisposals += 1;
              await record.dispose();
              if (faults.recordDispose === true) throw new Error('injected record dispose failure');
            },
          };
        },
        async dispose() {
          counts.runDisposals += 1;
          await run.dispose();
        },
      };
    },
  };
  return { port: instrumented, counts };
}

async function runCore(
  criteria: readonly JsonValue[],
  maximumClassification: 'public' | 'gold' = 'gold',
  lifecycleFaults: { recordDispose?: boolean } = {},
) {
  const plan = await prepareEvaluationPlan(
    definitionWithCriteria(criteria),
    policy(maximumClassification),
    preparationRuntime(),
  );
  const clock = new DeterministicClock();
  const eventSequencer = new InMemoryRuntimeEventSequencer();
  const executionPort = executor(plan);
  const execution = await executeRunPlanSource(plan, {
    executorsByTargetId: new Map(plan.execution.targets.map((target) => [
      target.targetId,
      executionPort,
    ])),
    clock,
    eventSequencer,
  }, { runId: 'output-assertion-run', bundleId: 'output-assertion-execution' });
  const adapted = createSameProcessEvaluatorAdapter({
    identity: OUTPUT_ASSERTION_EVALUATOR_IDENTITY,
    sessionIsolationKey: 'output-assertion-session',
    resourceLeases: {
      forRun: () => ({
        bindingId: 'output-assertions-binding',
        consumerKind: 'evaluator',
        resourcesByResourceId: new Map(),
      }),
    },
    implementation: createOutputAssertionEvaluatorImplementation(),
  });
  const instrumented = instrumentLifecycle(adapted, lifecycleFaults);
  const evaluation = await evaluateExecutionBundle(plan, execution, {
    evaluatorsByEvaluatorId: new Map([['output-assertions', instrumented.port]]),
    clock,
    eventSequencer,
  }, { runId: 'output-assertion-run', bundleId: 'output-assertion-evaluation' });
  return { plan, execution, evaluation, counts: instrumented.counts };
}

describe('output-only deterministic assertion Evaluator', () => {
  it('runs through a prepared Core plan and preserves observations, evidence, and missingness', async () => {
    const result = await runCore(VALID_CRITERIA);
    expect(result.evaluation.evaluationBundleStatus).toBe('completed');
    expect(result.evaluation.coverage).toMatchObject({ eligible: 2, completed: 2 });
    expect(result.counts).toEqual({
      runOpens: 1,
      runDisposals: 1,
      recordOpens: 2,
      recordDisposals: 2,
      evaluations: 2,
    });
    for (const record of result.evaluation.records) {
      expect(record.evaluationStatus).toBe('completed');
      if (record.evaluationStatus !== 'completed') continue;
      expect(record.observations.map((observation) => ({
        metricId: observation.metricId,
        observationStatus: observation.observationStatus,
        value: observation.observationStatus === 'observed' ? observation.value : undefined,
        reasonCode: observation.observationStatus === 'missing'
          ? observation.reasonCode
          : undefined,
      }))).toEqual([
        { metricId: 'contains-hello', observationStatus: 'observed', value: true, reasonCode: undefined },
        { metricId: 'short-enough', observationStatus: 'observed', value: true, reasonCode: undefined },
        { metricId: 'contains-missing', observationStatus: 'observed', value: false, reasonCode: undefined },
        { metricId: 'fact-set', observationStatus: 'observed', value: true, reasonCode: undefined },
        { metricId: 'not-applicable', observationStatus: 'missing', value: undefined, reasonCode: 'criterion-not-applicable' },
      ]);
      record.observations.slice(0, OUTPUT_METRIC_IDS.length).forEach((observation, index) => {
        expect(observation.evidence).toMatchObject({
          contentKind: 'inline',
          classification: 'gold',
          value: {
            schemaVersion: 'omk.output-assertion-evidence/v1',
            criterionId: OUTPUT_METRIC_IDS[index],
            detail: scoringFixture.deterministicAssertions.expected.details[index],
          },
        });
      });
    }
  });

  it('fails closed when an execution-aware assertion is routed to the output-only family', async () => {
    const result = await runCore([{
      criterionId: 'cost-gate',
      metricId: 'contains-hello',
      assertion: { type: 'cost_max', value: 0.1 },
    }]);
    expect(result.evaluation.evaluationBundleStatus).toBe('failed');
    expect(result.evaluation.coverage).toMatchObject({ notStarted: 2, completed: 0 });
    expect(result.evaluation.records).toEqual([]);
    expect(result.counts).toMatchObject({
      runOpens: 1,
      runDisposals: 1,
      recordOpens: 2,
      recordDisposals: 0,
      evaluations: 0,
    });
  });

  it('lets Core enforce the sealed evidence classification ceiling', async () => {
    const result = await runCore(VALID_CRITERIA, 'public');
    expect(result.evaluation.evaluationBundleStatus).toBe('completed');
    expect(result.evaluation.coverage).toMatchObject({ failed: 2, completed: 0 });
    for (const record of result.evaluation.records) {
      expect(record).toMatchObject({
        evaluationStatus: 'failed',
        error: { code: 'evidence-classification-exceeded', stage: 'infrastructure' },
      });
    }
  });

  it('fails the Core run when record disposal is not clean', async () => {
    const result = await runCore(VALID_CRITERIA, 'gold', { recordDispose: true });
    expect(result.evaluation).toMatchObject({
      evaluationBundleStatus: 'failed',
      terminationReasonCode: 'evaluator-record-dispose-failed',
      coverage: { failed: 0, completed: 2 },
    });
    expect(result.counts).toMatchObject({
      runOpens: 1,
      runDisposals: 1,
      recordOpens: 2,
      recordDisposals: 2,
      evaluations: 2,
    });
  });

  it('keeps every synchronous assertion type in exactly one execution-input family', () => {
    const outputTypes = new Set<string>(OUTPUT_ONLY_SYNC_ASSERTION_TYPE_NAMES);
    const executionTypes = new Set<string>(EXECUTION_AWARE_SYNC_ASSERTION_TYPE_NAMES);
    expect([...outputTypes].filter((type) => executionTypes.has(type))).toEqual([]);
    expect([...outputTypes, ...executionTypes].sort()).toEqual(
      [...SYNC_ASSERTION_TYPE_NAMES].sort(),
    );
  });

  it('raises derived evidence classification and cooperates with cancellation', async () => {
    const implementation = createOutputAssertionEvaluatorImplementation();
    const run = {
      runId: 'direct-output-assertion-run',
      evaluationPlanDigest: digestCanonicalJson({ plan: 'direct-output-assertion' }),
    };
    const scope = {
      sessionIsolationKey: 'direct-session',
      runIsolationKey: digestCanonicalJson({ run: 'direct-output-assertion' }),
      operationIsolationKey: digestCanonicalJson({ operation: 'direct-output-assertion' }),
    };
    const resources = {
      bindingId: 'output-assertions-binding',
      consumerKind: 'evaluator' as const,
      resourcesByResourceId: new Map(),
    };
    const record = {
      targetId: 'control',
      sampleId: 'sample-1',
      trialIndex: 0,
      trialId: digestCanonicalJson({ trial: 'direct-output-assertion' }),
      evaluatorId: 'output-assertions',
      measurement: {
        instrumentId: 'omk-output-assertions',
        ensembleMemberId: 'deterministic-local',
        replicateGroupId: 'deterministic-primary',
        replicateIndex: 0,
      },
      evaluationId: digestCanonicalJson({ evaluation: 'direct-output-assertion' }),
      bindings: [{
        bindingId: OUTPUT_ASSERTION_BINDINGS.actual,
        sourceKind: 'output' as const,
        value: scoringFixture.deterministicAssertions.output,
        classification: 'secret' as const,
      }, {
        bindingId: OUTPUT_ASSERTION_BINDINGS.criteria,
        sourceKind: 'evaluation-context' as const,
        value: {
          schemaVersion: OUTPUT_ASSERTION_CONTEXT_SCHEMA_VERSION,
          criteria: VALID_CRITERIA,
        },
        classification: 'public' as const,
      }],
      metrics: definitionWithCriteria(VALID_CRITERIA).metrics,
    };
    const runState = await implementation.openRun({ run, scope, resources });
    const recordState = await implementation.openRecord({
      run,
      runState,
      record,
      scope,
      resources,
    });
    const activeController = new AbortController();
    const attempt = {
      attemptId: digestCanonicalJson({ attempt: 'direct-output-assertion' }),
      attemptNumber: 1,
      signal: activeController.signal,
    };
    const result = await implementation.evaluate({
      run,
      runState,
      record,
      recordState,
      attempt,
      scope,
      resources,
    });
    expect(result.observations[0].evidence?.classification).toBe('secret');

    const cancellation = new Error('cancel output assertion');
    const cancelledController = new AbortController();
    cancelledController.abort(cancellation);
    await expect(implementation.evaluate({
      run,
      runState,
      record,
      recordState,
      attempt: { ...attempt, signal: cancelledController.signal },
      scope,
      resources,
    })).rejects.toBe(cancellation);
  });

  it('isolates JSON Schema registries between independent criteria', () => {
    const evaluateAssertion = createIsolatedDeterministicAssertionEvaluator();
    const schemaId = 'https://example.com/omk/output-assertion';
    expect(evaluateAssertion('{"value":"text"}', {
      type: 'json_schema',
      schema: {
        $id: schemaId,
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    })).toBe(true);
    expect(evaluateAssertion('{"value":42}', {
      type: 'json_schema',
      schema: {
        $id: schemaId,
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
    })).toBe(true);
  });

  it('registers a production factory with explicit local preflight dispositions', async () => {
    const factory = createBuiltinOmkScoringBindingFactories()
      .evaluatorsByImplementationId.get(OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID);
    expect(factory).toBeDefined();
    const resolved = await factory!({
      sessionIsolationKey: 'factory-session',
      binding: {
        runtimeKind: 'evaluator',
        bindingId: 'output-assertions-binding',
        evaluatorId: 'output-assertions',
        implementationId: OUTPUT_ASSERTION_EVALUATOR_IMPLEMENTATION_ID,
        measurement: {
          instrumentId: 'omk-output-assertions',
          ensembleMemberId: 'deterministic-local',
          replicateGroupId: 'deterministic-primary',
          replicateIndex: 0,
        },
        resourceLeaseRequirements: [],
      },
      evaluator: definitionWithCriteria(VALID_CRITERIA).evaluators[0],
      resourceLeases: {
        forRun: () => ({
          bindingId: 'output-assertions-binding',
          consumerKind: 'evaluator',
          resourcesByResourceId: new Map(),
        }),
      },
    });
    expect(resolved.port.identity).toEqual(OUTPUT_ASSERTION_EVALUATOR_IDENTITY);
    expect(resolved.preflightDeclarations).toEqual([
      expect.objectContaining({ preflightKind: 'credential', preflightDisposition: 'not-required' }),
      expect.objectContaining({ preflightKind: 'connectivity', preflightDisposition: 'not-required' }),
    ]);
  });
});
