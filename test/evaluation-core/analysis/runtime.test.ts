import { describe, expect, it } from 'vitest';
import {
  digestArtifactPayload,
  digestCanonicalJson,
  parseAnalysisBundle,
  parseEvaluationReport,
  type AnalysisBundle,
  type EvaluationBundle,
  type RuntimeIdentity,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  prepareEvaluationPlan,
  type AnalysisRuntimeRequirement,
  type PreparationRuntime,
} from '../../../src/evaluation-core/compiler/index.js';
import {
  executeRunPlan,
  InMemoryRuntimeEventSequencer,
  type ExecutionClock,
  type ExecutionExecutor,
} from '../../../src/evaluation-core/execution/index.js';
import {
  evaluateExecutionBundle,
  type EvaluationEvaluator,
} from '../../../src/evaluation-core/evaluation/index.js';
import {
  analyzeEvaluationBundle,
  createBuiltinAnalysisNodes,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  decideAnalysis,
  resolveBuiltinAnalysisRuntime,
  startAnalysis,
  startDecision,
  startReportMaterialization,
} from '../../../src/evaluation-core/analysis/index.js';
import { testRuntime, validDefinition, validPolicy } from '../compiler/fixtures.js';

type Plan = Awaited<ReturnType<typeof prepareEvaluationPlan>>;

class FakeClock implements ExecutionClock {
  now = 0;

  monotonicNow(): number { return this.now; }

  timestamp(): string {
    const timestamp = new Date(Date.UTC(2026, 7, 29) + this.now).toISOString();
    this.now += 1;
    return timestamp;
  }

  async sleep(delayMs: number): Promise<void> {
    this.now += delayMs;
  }
}

function analysisAwareRuntime(): PreparationRuntime {
  const base = testRuntime();
  return {
    resolveExecutor: (requirement) => base.resolveExecutor(requirement),
    resolveEvaluator: (requirement) => base.resolveEvaluator(requirement),
    resolveAnalysis(requirement: Readonly<AnalysisRuntimeRequirement>) {
      const resolution = resolveBuiltinAnalysisRuntime(requirement);
      if (resolution === undefined) throw new Error('unknown builtin');
      return resolution;
    },
    validateExtension: (request) => base.validateExtension?.(request),
  };
}

async function makePlan(mutate?: (
  definition: ReturnType<typeof validDefinition>,
  policy: ReturnType<typeof validPolicy>,
) => void): Promise<Plan> {
  const definition = validDefinition();
  delete definition.analysisGraph.nodes[0].parameters;
  definition.decisionPolicy = {
    ...definition.decisionPolicy!,
    parameters: { threshold: 0.4 },
  };
  const policy = validPolicy();
  delete policy.execution.timeoutMs;
  delete policy.evaluation.timeoutMs;
  policy.evidence.trace = 'full';
  mutate?.(definition, policy);
  return prepareEvaluationPlan(definition, policy, analysisAwareRuntime());
}

function identity(
  plan: Plan,
  runtimeKind: 'executor' | 'evaluator',
  referenceId: string,
): RuntimeIdentity {
  const runtimes = runtimeKind === 'executor'
    ? plan.execution.runtimes
    : plan.evaluation.runtimes;
  const runtime = runtimes.find((candidate) => (
    candidate.runtimeKind === runtimeKind && candidate.referenceId === referenceId
  ));
  if (runtime === undefined) throw new Error('missing runtime');
  return structuredClone(runtime.identity) as RuntimeIdentity;
}

function executor(plan: Plan, referenceId: string): ExecutionExecutor {
  return {
    identity: identity(plan, 'executor', referenceId),
    async openRun() {
      return {
        async openTrial(context) {
          return {
            async execute() {
              return {
                output: {
                  value: { answer: context.targetId === 'control' ? 'A' : 'B' },
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

function evaluator(plan: Plan, missing = false): EvaluationEvaluator {
  return {
    identity: identity(plan, 'evaluator', 'exact'),
    async openRun() {
      return {
        async openRecord(context) {
          return {
            async evaluate() {
              return {
                observations: [missing ? {
                  metricId: 'correct',
                  observationStatus: 'missing' as const,
                  valueType: 'boolean' as const,
                  reasonCode: 'evaluator-omitted-value',
                } : {
                  metricId: 'correct',
                  observationStatus: 'observed' as const,
                  valueType: 'boolean' as const,
                  value: context.targetId === 'control',
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
}

function resealAnalysisBundle(
  source: AnalysisBundle,
  mutate: (draft: AnalysisBundle) => void,
): AnalysisBundle {
  const draft = structuredClone(source);
  mutate(draft);
  for (const record of draft.records) {
    const payload: Record<string, unknown> = { ...record };
    delete payload.recordDigest;
    record.recordDigest = digestCanonicalJson(payload);
  }
  draft.bundleDigest = digestArtifactPayload(draft, 'bundleDigest');
  return draft;
}

function resealEvaluationBundle(
  source: EvaluationBundle,
  mutate: (draft: EvaluationBundle) => void,
): EvaluationBundle {
  const draft = structuredClone(source);
  mutate(draft);
  draft.bundleDigest = digestArtifactPayload(draft, 'bundleDigest');
  return draft;
}

describe('Evaluation Core Analysis and Decision Runtime', () => {
  it('derives a validated AnalysisBundle, decision, and materialized Report', async () => {
    const plan = await makePlan();
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlan(plan, {
      executors: new Map([
        ['executor-alias', executor(plan, 'control')],
      ]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-1', bundleId: 'execution-analysis-1' });
    const evaluation = await evaluateExecutionBundle(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-1', bundleId: 'evaluation-analysis-1' });
    const ports = {
      analysisNodes: createBuiltinAnalysisNodes(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
    };
    const analysis = await analyzeEvaluationBundle(
      plan,
      execution,
      evaluation,
      ports,
      { runId: 'run-analysis-1', bundleId: 'analysis-1' },
    );

    expect(analysis.analysisBundleStatus).toBe('completed');
    expect(analysis.coverage).toMatchObject({ completed: 1, failed: 0 });
    expect(analysis.records[0]).toMatchObject({
      analysisStatus: 'completed',
      resultId: 'correct-rate',
      resultType: 'scalar',
      value: 0.5,
      coverage: { planned: 2, observed: 2, included: 2 },
    });
    expect(parseAnalysisBundle(analysis, plan, execution, evaluation)).toEqual(analysis);

    const decisionRun = startDecision(
      plan,
      execution,
      evaluation,
      analysis,
      ports,
      { runId: 'run-analysis-1' },
    );
    const decision = await decisionRun.result;
    const decisionEvents = [];
    for await (const event of decisionRun.events) decisionEvents.push(event);
    expect(decision).toMatchObject({ decisionStatus: 'decided', verdict: 'PROGRESS' });
    expect(decisionEvents.map((event) => event.eventKind)).toEqual([
      'decision.started',
      'decision.completed',
    ]);

    const reportRun = startReportMaterialization(
      plan,
      execution,
      evaluation,
      analysis,
      decision,
      ports,
      {
        runId: 'run-analysis-1',
        reportId: 'report-analysis-1',
        annotations: { owner: 'host' },
      },
    );
    const report = await reportRun.result;
    const reportEvents = [];
    for await (const event of reportRun.events) reportEvents.push(event);
    expect(report.status).toEqual({
      runStatus: 'completed',
      evidenceStatus: 'complete',
      conclusionStatus: 'conclusive',
    });
    expect(parseEvaluationReport(
      report,
      plan,
      execution,
      evaluation,
      analysis,
    )).toEqual(report);
    expect(reportEvents.map((event) => event.eventKind)).toEqual(['report.materialized']);
    expect(reportEvents[0].sequence).toBeGreaterThan(
      decisionEvents[decisionEvents.length - 1].sequence,
    );

    const withUris = structuredClone(report);
    withUris.bundles[0].uri = 'https://example.test/execution.json';
    withUris.reportDigest = digestArtifactPayload(withUris, 'reportDigest');
    expect(parseEvaluationReport(
      withUris,
      plan,
      execution,
      evaluation,
      analysis,
    )).toEqual(withUris);

    const builtinPolicy = ports.decisionPolicies.get('progress/v1');
    if (builtinPolicy === undefined) throw new Error('missing DecisionPolicy');
    const failedDecision = await decideAnalysis(
      plan,
      execution,
      evaluation,
      analysis,
      {
        ...ports,
        decisionPolicies: new Map([['progress/v1', {
          identity: builtinPolicy.identity,
          decide: async () => { throw new Error('policy failed'); },
        }]]),
      },
      { runId: 'run-analysis-1' },
    );
    expect(failedDecision).toMatchObject({
      decisionStatus: 'failed',
      error: { code: 'decision-runtime-failed', stage: 'analysis' },
    });
  });

  it('rejects a fully resealed AnalysisBundle with a forged Runtime identity', async () => {
    const plan = await makePlan();
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlan(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-forge', bundleId: 'execution-analysis-forge' });
    const evaluation = await evaluateExecutionBundle(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-forge', bundleId: 'evaluation-analysis-forge' });
    const ports = {
      analysisNodes: createBuiltinAnalysisNodes(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
    };
    const analysis = await analyzeEvaluationBundle(
      plan,
      execution,
      evaluation,
      ports,
      { runId: 'run-analysis-forge', bundleId: 'analysis-forge' },
    );
    const forged = resealAnalysisBundle(analysis, (draft) => {
      draft.records[0].implementation.fingerprint = 'forged-analysis-runtime';
    });

    expect(() => parseAnalysisBundle(forged, plan, execution, evaluation)).toThrow(
      /sealed node and Runtime binding/,
    );
  });

  it('binds AnalysisBundle to the exact EvaluationBundle content', async () => {
    const plan = await makePlan();
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlan(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-source', bundleId: 'execution-analysis-source' });
    const evaluation = await evaluateExecutionBundle(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-source', bundleId: 'evaluation-analysis-source' });
    const ports = {
      analysisNodes: createBuiltinAnalysisNodes(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
    };
    const analysis = await analyzeEvaluationBundle(
      plan,
      execution,
      evaluation,
      ports,
      { runId: 'run-analysis-source', bundleId: 'analysis-source' },
    );
    const replacement = resealEvaluationBundle(evaluation, (draft) => {
      draft.bundleId = 'evaluation-replacement';
    });

    expect(() => parseAnalysisBundle(analysis, plan, execution, replacement)).toThrow(
      /parent identities/,
    );
  });

  it('returns an inconclusive decision instead of converting missing observations to zero', async () => {
    const plan = await makePlan();
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlan(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-missing', bundleId: 'execution-analysis-missing' });
    const evaluation = await evaluateExecutionBundle(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan, true)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-missing', bundleId: 'evaluation-analysis-missing' });
    const ports = {
      analysisNodes: createBuiltinAnalysisNodes(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
    };
    const analysis = await analyzeEvaluationBundle(
      plan,
      execution,
      evaluation,
      ports,
      { runId: 'run-analysis-missing', bundleId: 'analysis-missing' },
    );
    const decision = await decideAnalysis(
      plan,
      execution,
      evaluation,
      analysis,
      ports,
      { runId: 'run-analysis-missing' },
    );

    expect(analysis.records[0]).toMatchObject({
      analysisStatus: 'inconclusive',
      coverage: { observed: 0, missing: 2, included: 0 },
    });
    expect(analysis.records[0].exclusions).toHaveLength(2);
    expect(analysis.records[0].exclusions.every(
      (exclusion) => exclusion.reasonCode === 'evaluator-omitted-value',
    )).toBe(true);
    const forgedCoverage = resealAnalysisBundle(analysis, (draft) => {
      draft.records[0].coverage.missing = 0;
      draft.records[0].coverage.invalid = 2;
    });
    expect(() => parseAnalysisBundle(
      forgedCoverage,
      plan,
      execution,
      evaluation,
    )).toThrow(/source observation universe/);
    expect(decision).toMatchObject({
      decisionStatus: 'not-decided',
      reasonCodes: expect.arrayContaining(['decision-analysis-result-unavailable']),
    });
  });

  it('materializes a cancelled partial AnalysisBundle for a pre-aborted signal', async () => {
    const plan = await makePlan();
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlan(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-cancel', bundleId: 'execution-analysis-cancel' });
    const evaluation = await evaluateExecutionBundle(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-cancel', bundleId: 'evaluation-analysis-cancel' });
    const controller = new AbortController();
    controller.abort();
    const run = startAnalysis(plan, execution, evaluation, {
      analysisNodes: createBuiltinAnalysisNodes(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
    }, {
      runId: 'run-analysis-cancel',
      bundleId: 'analysis-cancel',
      signal: controller.signal,
    });
    const analysis = await run.result;

    expect(analysis.analysisBundleStatus).toBe('cancelled');
    expect(analysis.records[0].analysisStatus).toBe('not-evaluated');
    expect(analysis.coverage.notStarted).toBe(1);
  });

  it('keeps EventWriter infrastructure failure separate from node facts', async () => {
    const plan = await makePlan((_definition, policy) => {
      policy.eventDelivery = {
        writerMode: 'required',
        backpressureMode: 'block',
        writerFailureMode: 'fail-run',
      };
    });
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const workingWriter = { write: async () => undefined };
    const execution = await executeRunPlan(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
      eventWriter: workingWriter,
    }, { runId: 'run-analysis-writer', bundleId: 'execution-analysis-writer' });
    const evaluation = await evaluateExecutionBundle(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
      eventWriter: workingWriter,
    }, { runId: 'run-analysis-writer', bundleId: 'evaluation-analysis-writer' });
    const analysis = await analyzeEvaluationBundle(plan, execution, evaluation, {
      analysisNodes: createBuiltinAnalysisNodes(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
      eventWriter: { write: async () => { throw new Error('writer down'); } },
    }, { runId: 'run-analysis-writer', bundleId: 'analysis-writer' });

    expect(analysis.analysisBundleStatus).toBe('failed');
    expect(analysis.terminationReasonCode).toBe('analysis-event-writer-failed');
    expect(analysis.coverage.failed).toBe(0);
    expect(analysis.records[0].analysisStatus).toBe('not-evaluated');

    const failedPorts = {
      analysisNodes: createBuiltinAnalysisNodes(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
      eventWriter: { write: async () => { throw new Error('writer down'); } },
    };
    const decision = await decideAnalysis(
      plan,
      execution,
      evaluation,
      analysis,
      failedPorts,
      { runId: 'run-analysis-writer' },
    );
    expect(decision).toMatchObject({
      decisionStatus: 'failed',
      error: { code: 'decision-event-writer-failed', stage: 'infrastructure' },
    });

    const reportRun = startReportMaterialization(
      plan,
      execution,
      evaluation,
      analysis,
      decision,
      failedPorts,
      { runId: 'run-analysis-writer', reportId: 'report-writer-failure' },
    );
    await expect(reportRun.result).rejects.toMatchObject({
      evaluationError: { code: 'report-event-writer-failed' },
    });
    const reportEvents = [];
    for await (const event of reportRun.events) reportEvents.push(event);
    expect(reportEvents.map((event) => event.eventKind)).toEqual(['report.failed']);
  });
});
