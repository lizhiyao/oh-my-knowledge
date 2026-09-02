import { describe, expect, it } from 'vitest';
import {
  createEvaluationEngine,
  digestCanonicalJson,
  type EvaluationEngineRuntime,
  type EvaluationEvent,
  type EvaluationRun,
  type EvaluationRunResult,
  type Evaluator,
  type Executor,
  type CoreSchemaValidator,
  type RuntimeIdentity,
  type Sha256Digest,
} from '../../../src/package-api/eval-core.js';
import {
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  resolveBuiltinAnalysisRuntime,
} from '../../../src/eval-core/analysis/index.js';
import type { SealedRunPlan } from '../../../src/eval-core/compiler/index.js';
import { validDefinition, validPolicy, testRuntime } from '../compiler/fixtures.js';

class DeterministicClock {
  #elapsed = 0;

  monotonicNow(): number {
    return this.#elapsed;
  }

  timestamp(): string {
    const timestamp = new Date(Date.UTC(2026, 7, 30) + this.#elapsed).toISOString();
    this.#elapsed += 1;
    return timestamp;
  }

  async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.#elapsed += delayMs;
  }
}

function runtimeIdentity(
  plan: SealedRunPlan,
  runtimeKind: 'executor' | 'evaluator',
  referenceId: string,
) {
  const runtimes = runtimeKind === 'executor'
    ? plan.execution.runtimes
    : plan.evaluation.runtimes;
  const runtime = runtimes.find((candidate) => (
    candidate.runtimeKind === runtimeKind && candidate.referenceId === referenceId
  ));
  if (runtime === undefined) throw new Error(`Missing ${runtimeKind} ${referenceId}.`);
  return structuredClone(runtime.identity) as RuntimeIdentity;
}

function makeExecutor(plan: SealedRunPlan): Executor {
  return {
    identity: runtimeIdentity(plan, 'executor', 'control'),
    async openRun() {
      return {
        async openTrial(context) {
          return {
            async execute(attempt) {
              if (attempt.signal.aborted) throw attempt.signal.reason;
              const input = context.input as { answerHint: string };
              return {
                output: {
                  value: { answer: input.answerHint ?? 'A' },
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

function makeEvaluator(plan: SealedRunPlan): Evaluator {
  return {
    identity: runtimeIdentity(plan, 'evaluator', 'exact'),
    async openRun() {
      return {
        async openRecord(context) {
          return {
            async evaluate(attempt) {
              if (attempt.signal.aborted) throw attempt.signal.reason;
              const actual = context.bindings.find((binding) => binding.bindingId === 'actual');
              const gold = context.bindings.find((binding) => binding.bindingId === 'gold');
              return {
                observations: [{
                  metricId: 'correct',
                  observationStatus: 'observed' as const,
                  valueType: 'boolean' as const,
                  value: actual?.value === gold?.value,
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

async function createRuntime(): Promise<{
  runtime: EvaluationEngineRuntime;
  definition: ReturnType<typeof validDefinition>;
  policy: ReturnType<typeof validPolicy>;
}> {
  const definition = validDefinition();
  definition.analysisGraph.nodes[0].parameters = {};
  const policy = validPolicy();
  policy.retry.maxAttempts = 1;
  policy.evaluation.retry.maxAttempts = 1;
  policy.evidence.trace = 'none';
  const base = testRuntime();
  const schemaValidators = new Map([
    ...base.schemaValidators,
    ...createBuiltinAnalysisSchemaValidators(),
  ]);
  const preparation = {
    resolveExecutor: base.resolveExecutor,
    resolveEvaluator: base.resolveEvaluator,
    resolveAnalysis(requirement: Parameters<typeof resolveBuiltinAnalysisRuntime>[0]) {
      const resolution = resolveBuiltinAnalysisRuntime(requirement);
      if (resolution === undefined) throw new Error('Missing built-in Analysis Runtime.');
      return resolution;
    },
  };
  const plan = await (await import('../../../src/eval-core/compiler/index.js'))
    .prepareEvaluationPlan(definition, policy, { ...preparation, schemaValidators });
  const executor = makeExecutor(plan);
  const evaluator = makeEvaluator(plan);
  const analysisNodes = createBuiltinAnalysisNodes();
  const missingPolicies = createBuiltinMissingPolicies();
  const decisionPolicies = createBuiltinDecisionPolicies();
  return {
    definition,
    policy,
    runtime: {
      bindings: {
        resolveExecutor() {
          return {
            runtimeKind: 'executor',
            resolution: { identity: executor.identity, satisfiesVersionConstraint: true },
            port: executor,
          };
        },
        resolveEvaluator() {
          return {
            runtimeKind: 'evaluator',
            resolution: { identity: evaluator.identity, satisfiesVersionConstraint: true },
            port: evaluator,
          };
        },
        resolveAnalysis(requirement) {
          const resolution = resolveBuiltinAnalysisRuntime(requirement);
          if (resolution === undefined) throw new Error('Missing built-in Analysis Runtime.');
          if (requirement.requirementKind === 'missing-policy') {
            const port = missingPolicies.get(requirement.implementationId);
            if (port === undefined) throw new Error('Missing built-in MissingPolicy.');
            return { runtimeKind: 'missing-policy', resolution, port };
          }
          if (requirement.requirementKind === 'decision-policy') {
            const port = decisionPolicies.get(requirement.implementationId);
            if (port === undefined) throw new Error('Missing built-in DecisionPolicy.');
            return { runtimeKind: 'decision-policy', resolution, port };
          }
          const port = analysisNodes.get(requirement.implementationId);
          if (port === undefined) throw new Error('Missing built-in Analysis node.');
          return { runtimeKind: 'analysis-node', resolution, port };
        },
      },
      clock: new DeterministicClock(),
      schemaValidators,
    },
  };
}

async function consume(run: {
  events: AsyncIterable<EvaluationEvent>;
  result: Promise<EvaluationRunResult>;
}) {
  const events: EvaluationEvent[] = [];
  const consuming = (async () => {
    for await (const event of run.events) events.push(event);
  })();
  const result = await run.result;
  await consuming;
  return { events, result };
}

async function collectEvents(events: AsyncIterable<EvaluationEvent>): Promise<EvaluationEvent[]> {
  const collected: EvaluationEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('embedded Evaluation Engine', () => {
  it('runs and re-scores through a prepared stage capability without re-executing Targets', async () => {
    const fixture = await createRuntime();
    let executorRuns = 0;
    const runtime: EvaluationEngineRuntime = {
      ...fixture.runtime,
      bindings: {
        ...fixture.runtime.bindings,
        async resolveExecutor(requirement) {
          const binding = await fixture.runtime.bindings.resolveExecutor(requirement);
          return {
            ...binding,
            port: {
              identity: binding.port.identity,
              async openRun(context) {
                executorRuns += 1;
                return binding.port.openRun(context);
              },
            },
          };
        },
      },
    };
    const engine = createEvaluationEngine(runtime);
    const original = await engine.prepare(fixture.definition, fixture.policy);
    const executionStages = original.stages({ runId: 'staged-execution' });
    const executionRun = executionStages.execute();
    const execution = await executionRun.source;
    await executionStages.close();

    expect(executorRuns).toBe(2);
    const changedDefinition = structuredClone(fixture.definition);
    changedDefinition.dataset.samples[0].expected = { answer: 'B' };
    const rescored = await engine.prepare(changedDefinition, fixture.policy);
    const executionSource = rescored.admitExecutionBundle(
      structuredClone(execution.bundle),
      {
        verifiedProvenanceBundleDigests: new Set([
          execution.bundle.bundleDigest as Sha256Digest,
        ]),
      },
    );
    executorRuns = 0;

    const stages = rescored.stages({
      runId: 'staged-rescore',
      annotations: { source: 'persisted-execution' },
    });
    const evaluationRun = stages.evaluate({ execution: executionSource });
    const evaluation = await evaluationRun.source;
    const analysisRun = stages.analyze({ execution: executionSource, evaluation });
    const analysis = await analysisRun.source;
    const decisionRun = stages.decide({ execution: executionSource, evaluation, analysis });
    const decision = await decisionRun.source;
    const reportRun = stages.materializeReport({
      execution: executionSource,
      evaluation,
      analysis,
      ...(decision === undefined ? {} : { decision }),
    });
    const report = await reportRun.result;
    await stages.close();

    expect(executorRuns).toBe(0);
    expect(evaluation.bundle.executionBundleDigest).toBe(execution.bundle.bundleDigest);
    expect(report.annotations).toEqual({ source: 'persisted-execution' });
    expect(report.bundles.map((bundle) => bundle.bundleDigest)).toEqual([
      execution.bundle.bundleDigest,
      evaluation.bundle.bundleDigest,
      analysis.bundle.bundleDigest,
    ]);

    const stageEvents = (await Promise.all([
      collectEvents(evaluationRun.events),
      collectEvents(analysisRun.events),
      collectEvents(decisionRun.events),
      collectEvents(reportRun.events),
    ])).flat();
    expect(stageEvents.map((event) => event.sequence)).toEqual(
      stageEvents.map((_, index) => index),
    );
    expect(stageEvents.every((event) => event.runId === 'staged-rescore')).toBe(true);

    const importedEvaluation = rescored.admitEvaluationBundle(
      structuredClone(evaluation.bundle),
      {
        execution: executionSource,
        verification: {
          verifiedProvenanceBundleDigests: new Set([
            evaluation.bundle.bundleDigest as Sha256Digest,
          ]),
          executionSourceTrust: execution.bundle.provenance.trust,
        },
      },
    );
    const importedAnalysis = rescored.admitAnalysisBundle(
      structuredClone(analysis.bundle),
      {
        execution: executionSource,
        evaluation: importedEvaluation,
        verification: {
          verifiedProvenanceBundleDigests: new Set([
            analysis.bundle.bundleDigest as Sha256Digest,
          ]),
          evaluationSourceTrust: evaluation.bundle.provenance.trust,
        },
      },
    );
    const importedDecision = decision === undefined
      ? undefined
      : rescored.admitDecisionResult(structuredClone(decision.result), {
          execution: executionSource,
          evaluation: importedEvaluation,
          analysis: importedAnalysis,
          verification: {
            verifiedPolicyExecutionDigests: new Set([
              decision.result.decisionDigest as Sha256Digest,
            ]),
            analysisSourceTrust: analysis.bundle.provenance.trust,
          },
        });
    expect(rescored.admitReport(structuredClone(report), {
      execution: executionSource,
      evaluation: importedEvaluation,
      analysis: importedAnalysis,
      ...(importedDecision === undefined ? {} : { decision: importedDecision }),
    })).toEqual(report);
  });

  it('binds imported stage documents to the prepared Plan and opaque source chain', async () => {
    const fixture = await createRuntime();
    const prepared = await createEvaluationEngine(fixture.runtime).prepare(
      fixture.definition,
      fixture.policy,
    );
    const sourceStages = prepared.stages({ runId: 'staged-admission-source' });
    const source = await sourceStages.execute().source;
    await sourceStages.close();
    const transported = structuredClone(source.bundle);
    const admitted = prepared.admitExecutionBundle(transported);

    const changedDefinition = structuredClone(fixture.definition);
    changedDefinition.dataset.samples[0].input = { question: 'changed' };
    const mismatched = await createEvaluationEngine(fixture.runtime).prepare(
      changedDefinition,
      fixture.policy,
    );
    expect(() => mismatched.admitExecutionBundle(transported)).toThrowError(
      /Execution source|ExecutionBundle|Execution bundle/,
    );
    expect(() => prepared.stages({ runId: 'staged-forged-source' }).evaluate({
      execution: {
        bundle: admitted.bundle,
        planVerification: admitted.planVerification,
      } as unknown as typeof admitted,
    })).toThrowError(/source returned by parseExecutionBundle/);

    const tampered = structuredClone(transported);
    tampered.records[0].executionCoordinateDigest = digestCanonicalJson({ tampered: true });
    expect(() => prepared.admitExecutionBundle(tampered)).toThrowError();
  });

  it('owns the Engine runId until the stage session reaches a terminal close', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const prepared = await engine.prepare(fixture.definition, fixture.policy);
    const session = prepared.stages({ runId: 'staged-owned-run-id' });
    const executionRun = session.execute();

    expect(() => prepared.stages({ runId: 'staged-owned-run-id' })).toThrowError(
      expect.objectContaining({ code: 'EVALUATION_STAGE_SESSION_RUN_ID_ACTIVE' }),
    );
    expect(() => session.execute()).toThrowError(
      expect.objectContaining({ code: 'EVALUATION_STAGE_SESSION_BUSY' }),
    );
    await executionRun.source;
    expect(() => session.execute()).toThrowError(
      expect.objectContaining({ code: 'EVALUATION_STAGE_ALREADY_STARTED' }),
    );
    await session.close();
    await expect(prepared.stages({ runId: 'staged-owned-run-id' }).close())
      .resolves.toBeUndefined();
  });

  it('cancels an in-flight stage and waits for Runtime disposal before releasing runId', async () => {
    const fixture = await createRuntime();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let disposedRuns = 0;
    let disposedTrials = 0;
    const runtime: EvaluationEngineRuntime = {
      ...fixture.runtime,
      bindings: {
        ...fixture.runtime.bindings,
        async resolveExecutor(requirement) {
          const binding = await fixture.runtime.bindings.resolveExecutor(requirement);
          const port: Executor = {
            identity: binding.port.identity,
            async openRun() {
              return {
                async openTrial() {
                  return {
                    async execute(attempt) {
                      startedResolve?.();
                      return await new Promise<never>((_resolve, reject) => {
                        if (attempt.signal.aborted) {
                          reject(attempt.signal.reason);
                          return;
                        }
                        attempt.signal.addEventListener(
                          'abort',
                          () => { reject(attempt.signal.reason); },
                          { once: true },
                        );
                      });
                    },
                    dispose() { disposedTrials += 1; },
                  };
                },
                dispose() { disposedRuns += 1; },
              };
            },
          };
          return { ...binding, port };
        },
      },
    };
    const prepared = await createEvaluationEngine(runtime).prepare(
      fixture.definition,
      fixture.policy,
    );
    const session = prepared.stages({ runId: 'staged-close-cancellation' });
    const run = session.execute();
    await started;
    await session.close();
    const source = await run.source;

    expect(source.bundle.executionBundleStatus).toBe('cancelled');
    expect(disposedTrials).toBeGreaterThan(0);
    expect(disposedRuns).toBe(2);
    await expect(prepared.stages({ runId: 'staged-close-cancellation' }).close())
      .resolves.toBeUndefined();
  });

  it('seals and runs distinct Target bindings that share one implementation', async () => {
    const fixture = await createRuntime();
    const opened: string[] = [];
    const runtime: EvaluationEngineRuntime = {
      ...fixture.runtime,
      bindings: {
        ...fixture.runtime.bindings,
        async resolveExecutor(requirement) {
          const base = await fixture.runtime.bindings.resolveExecutor(requirement);
          const identity: RuntimeIdentity = {
            ...structuredClone(base.port.identity),
            fingerprint: digestCanonicalJson({
              base: base.port.identity.fingerprint,
              targetId: requirement.referenceId,
            }),
            implementationManifest: {
              coverageKind: 'fingerprint-plus-facets',
              facets: [{ facetId: 'target-binding', value: requirement.referenceId }],
            },
          };
          const port: Executor = {
            identity,
            async openRun() {
              opened.push(requirement.referenceId);
              return {
                async openTrial(context) {
                  return {
                    async execute() {
                      const input = context.input as { answerHint?: string };
                      return {
                        output: {
                          value: { answer: input.answerHint ?? 'A' },
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
          return {
            runtimeKind: 'executor',
            resolution: { identity, satisfiesVersionConstraint: true },
            port,
          };
        },
      },
    };
    const prepared = await createEvaluationEngine(runtime).prepare(
      fixture.definition,
      fixture.policy,
    );
    const identities = prepared.plan.execution.runtimes
      .filter((entry) => entry.runtimeKind === 'executor')
      .map((entry) => entry.identity);

    expect(new Set(identities.map((identity) => identity.implementationId))).toEqual(
      new Set(['actual-executor/v1']),
    );
    expect(new Set(identities.map((identity) => identity.fingerprint)).size).toBe(2);
    expect((await prepared.start({ runId: 'embedded-distinct-target-bindings' }).result).status)
      .toBe('completed');
    expect(opened.sort()).toEqual(['control', 'treatment']);
  });

  it('rejects resolver and port split-brain before opening a Runtime resource', async () => {
    const fixture = await createRuntime();
    let opens = 0;
    const runtime: EvaluationEngineRuntime = {
      ...fixture.runtime,
      bindings: {
        ...fixture.runtime.bindings,
        async resolveExecutor(requirement) {
          const binding = await fixture.runtime.bindings.resolveExecutor(requirement);
          return {
            ...binding,
            port: {
              ...binding.port,
              identity: {
                ...binding.port.identity,
                fingerprint: digestCanonicalJson({ drifted: requirement.referenceId }),
              },
              async openRun(context) {
                opens += 1;
                return binding.port.openRun(context);
              },
            },
          };
        },
      },
    };

    await expect(createEvaluationEngine(runtime).prepare(fixture.definition, fixture.policy))
      .rejects.toMatchObject({
        code: 'EVAL_DEFINITION_RUNTIME_BINDING_INVALID',
        stage: 'configuration',
        preparationStage: 'runtime-resolution',
      });
    expect(opens).toBe(0);
  });

  it('captures prepared binding ports independently from later registry changes', async () => {
    const fixture = await createRuntime();
    const base = await fixture.runtime.bindings.resolveExecutor({
      referenceId: 'control',
      executorId: 'executor-alias',
      versionConstraint: '^1.0.0',
      protocolId: 'omk.invoke/v1',
      executionRequirements: fixture.definition.targets[0].executionRequirements,
    });
    const attempts: string[] = [];
    const port = (source: string): Executor => ({
      identity: base.port.identity,
      async openRun() {
        return {
          async openTrial(context) {
            return {
              async execute() {
                attempts.push(source);
                const input = context.input as { answerHint?: string };
                return {
                  output: {
                    value: { answer: input.answerHint ?? 'A', source },
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
    });
    let current = port('prepared');
    const runtime: EvaluationEngineRuntime = {
      ...fixture.runtime,
      bindings: {
        ...fixture.runtime.bindings,
        resolveExecutor() {
          return {
            runtimeKind: 'executor',
            resolution: { identity: current.identity, satisfiesVersionConstraint: true },
            port: current,
          };
        },
      },
    };
    const prepared = await createEvaluationEngine(runtime).prepare(
      fixture.definition,
      fixture.policy,
    );
    current = port('replacement');
    const result = await prepared.start({ runId: 'embedded-binding-snapshot' }).result;

    expect(result.status).toBe('completed');
    expect(attempts).toEqual(['prepared', 'prepared']);
  });

  it('captures validator schemas and functions for runtime and admission', async () => {
    const fixture = await createRuntime();
    const mutableValidators = new Map<string, CoreSchemaValidator>(
      [...fixture.runtime.schemaValidators].map(([key, validator]) => [key, {
        schema: structuredClone(validator.schema),
        parse: validator.parse.bind(validator),
      }]),
    );
    const runtime: EvaluationEngineRuntime = {
      ...fixture.runtime,
      schemaValidators: mutableValidators,
    };
    const engine = createEvaluationEngine(runtime);
    const prepared = await engine.prepare(fixture.definition, fixture.policy);

    for (const validator of mutableValidators.values()) {
      const mutable = validator as {
        schema: { schemaVersion: string };
        parse: CoreSchemaValidator['parse'];
      };
      mutable.schema.schemaVersion = 'mutated-after-prepare';
      mutable.parse = () => {
        throw new Error('mutated validator must not run');
      };
    }

    const stages = prepared.stages({ runId: 'embedded-validator-snapshot' });
    const execution = await stages.execute().source;
    const evaluation = await stages.evaluate({ execution }).source;
    const analysis = await stages.analyze({ execution, evaluation }).source;
    const admitted = prepared.admitAnalysisBundle(structuredClone(analysis.bundle), {
      execution,
      evaluation,
    });
    await stages.close();

    expect(analysis.bundle.analysisBundleStatus).toBe('completed');
    expect(admitted.bundle.bundleDigest).toBe(analysis.bundle.bundleDigest);

    mutableValidators.clear();
    await expect(engine.prepare(fixture.definition, fixture.policy)).rejects.toMatchObject({
      code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED',
      stage: 'configuration',
      preparationStage: 'runtime-resolution',
    });
  });

  it('returns malformed Runtime snapshot failures through the one-call result channel', async () => {
    const fixture = await createRuntime();
    const runtime = {
      ...fixture.runtime,
      schemaValidators: new Map([['invalid-validator', {
        schema: null,
        parse: undefined,
      }]]),
    } as unknown as EvaluationEngineRuntime;

    const run = createEvaluationEngine(runtime).start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-invalid-runtime-snapshot',
    });

    await expect(run.result).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'EVAL_DEFINITION_RUNTIME_BINDING_INVALID',
        stage: 'configuration',
      },
    });
    await expect(collectEvents(run.events)).resolves.toEqual([]);
  });

  it('isolates Evaluator sessions for multiple bindings of one implementation', async () => {
    const fixture = await createRuntime();
    delete fixture.policy.execution.timeoutMs;
    delete fixture.policy.evaluation.timeoutMs;
    fixture.definition.evaluators.push({
      ...structuredClone(fixture.definition.evaluators[0]),
      evaluatorId: 'exact-secondary',
      measurement: {
        instrumentId: 'exact-secondary-instrument',
        ensembleMemberId: 'exact-secondary-member',
        replicateGroupId: 'exact-secondary-group',
        replicateIndex: 0,
      },
    });
    const opened: string[] = [];
    const runtime: EvaluationEngineRuntime = {
      ...fixture.runtime,
      bindings: {
        ...fixture.runtime.bindings,
        async resolveEvaluator(requirement) {
          const base = await fixture.runtime.bindings.resolveEvaluator(requirement);
          const identity: RuntimeIdentity = {
            ...structuredClone(base.port.identity),
            fingerprint: digestCanonicalJson({
              base: base.port.identity.fingerprint,
              evaluatorId: requirement.referenceId,
            }),
          };
          const port: Evaluator = {
            identity,
            async openRun() {
              opened.push(requirement.referenceId);
              return {
                async openRecord() {
                  return {
                    async evaluate() {
                      return {
                        observations: [{
                          metricId: 'correct',
                          observationStatus: 'observed' as const,
                          valueType: 'boolean' as const,
                          value: true,
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
          return {
            runtimeKind: 'evaluator',
            resolution: { identity, satisfiesVersionConstraint: true },
            port,
          };
        },
      },
    };
    const prepared = await createEvaluationEngine(runtime).prepare(
      fixture.definition,
      fixture.policy,
    );
    const identities = prepared.plan.evaluation.runtimes
      .filter((entry) => entry.runtimeKind === 'evaluator')
      .map((entry) => entry.identity);
    const result = await prepared.start({ runId: 'embedded-evaluator-bindings' }).result;

    expect(result.status).toBe('completed');
    expect(new Set(identities.map((identity) => identity.implementationId))).toEqual(
      new Set(['actual-evaluator/v1']),
    );
    expect(new Set(identities.map((identity) => identity.fingerprint)).size).toBe(2);
    expect(opened.sort()).toEqual(['exact', 'exact-secondary']);
  });

  it('enforces one Run invocation budget across Execution and Evaluation', async () => {
    const fixture = await createRuntime();
    fixture.policy.budget.run.maxInvocations = 3;
    delete fixture.policy.execution.timeoutMs;
    delete fixture.policy.evaluation.timeoutMs;
    fixture.definition.dataset.samples[0].input = { answerHint: 'A' };
    const result = await createEvaluationEngine(fixture.runtime).start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-shared-budget',
    }).result;

    if (result.status === 'failed') throw new Error('Expected materialized partial artifacts.');
    const executionEntries = result.artifacts.execution.budgetSummary.entries;
    const finalEntries = result.artifacts.evaluation.budgetSummary.entries;
    expect(executionEntries).toHaveLength(2);
    expect(finalEntries).toHaveLength(3);
    expect(result.status).toBe('budget-exhausted');
    expect(finalEntries.slice(0, executionEntries.length)).toEqual(executionEntries);
    expect(result.report.budgetSummary).toEqual(result.artifacts.evaluation.budgetSummary);
    expect(result.artifacts.evaluation).toMatchObject({
      evaluationBundleStatus: 'budget-exhausted',
      coverage: { started: 1, notStarted: 1 },
    });
  });

  it('runs an in-memory multi-target evaluation through the public façade', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const { events, result } = await consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-completed',
      annotations: { owner: 'host' },
      eventBufferCapacity: 128,
    }));

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected a completed result.');
    expect(result.report.annotations).toEqual({ owner: 'host' });
    expect(result.artifacts.execution.records).toHaveLength(2);
    expect(result.artifacts.evaluation.records).toHaveLength(2);
    expect(events.length).toBeGreaterThan(10);
    expect(events.every((event) => event.runId === 'embedded-completed')).toBe(true);
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index),
    );
    expect(events.at(-1)?.eventKind).toBe('report.materialized');
  });

  it('returns structured configuration failures without rejecting result', async () => {
    const fixture = await createRuntime();
    const definition = structuredClone(fixture.definition);
    definition.targets[0].executorId = 'missing-executor';
    const runtime: EvaluationEngineRuntime = {
      ...fixture.runtime,
      bindings: {
        ...fixture.runtime.bindings,
        resolveExecutor(requirement) {
          if (requirement.executorId === 'missing-executor') {
            throw new Error('missing executor binding');
          }
          return fixture.runtime.bindings.resolveExecutor(requirement);
        },
      },
    };
    const result = await createEvaluationEngine(runtime).start(definition, {
      policy: fixture.policy,
      runId: 'embedded-invalid',
    }).result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected a failed result.');
    expect(result.error.stage).toBe('infrastructure');
    expect(result.error.code).toBe('EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED');
    expect(result.report).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'returns a structured failure for eventBufferCapacity %s',
    async (eventBufferCapacity) => {
      const fixture = await createRuntime();
      const engine = createEvaluationEngine(fixture.runtime);
      let run: EvaluationRun | undefined;

      expect(() => {
        run = engine.start(fixture.definition, {
          policy: fixture.policy,
          runId: `embedded-invalid-capacity-${eventBufferCapacity}`,
          eventBufferCapacity,
        });
      }).not.toThrow();
      if (run === undefined) throw new Error('Expected an EvaluationRun.');

      const { events, result } = await consume(run);
      expect(events).toEqual([]);
      expect(result).toMatchObject({
        status: 'failed',
        error: {
          code: 'EVALUATION_ENGINE_EVENT_BUFFER_CAPACITY_INVALID',
          stage: 'configuration',
        },
      });
    },
  );

  it('uses the structured failure channel for invalid prepared-run options', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const prepared = await engine.prepare(fixture.definition, fixture.policy);
    const runId = 'embedded-prepared-invalid-capacity';
    const invalid = await consume(prepared.start({
      runId,
      eventBufferCapacity: 0,
    }));

    expect(invalid.events).toEqual([]);
    expect(invalid.result).toMatchObject({
      status: 'failed',
      error: {
        code: 'EVALUATION_ENGINE_EVENT_BUFFER_CAPACITY_INVALID',
        stage: 'configuration',
      },
    });
    expect((await consume(prepared.start({ runId }))).result.status).toBe('completed');
  });

  it('rejects concurrent duplicate runIds and permits reuse after termination', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const prepared = await engine.prepare(fixture.definition, fixture.policy);
    const runId = 'embedded-active-run';
    const first = prepared.start({ runId });
    const duplicate = engine.start(fixture.definition, {
      policy: fixture.policy,
      runId,
    });

    const duplicateOutcome = await consume(duplicate);
    expect(duplicateOutcome.events).toEqual([]);
    expect(duplicateOutcome.result).toMatchObject({
      status: 'failed',
      error: {
        code: 'EVALUATION_ENGINE_RUN_ID_ACTIVE',
        stage: 'configuration',
      },
    });
    expect((await consume(first)).result.status).toBe('completed');
    expect((await consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId,
    }))).result.status).toBe('completed');
  });

  it('releases runId ownership after preparation failure', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const invalidDefinition = structuredClone(fixture.definition);
    invalidDefinition.targets = [];
    const runId = 'embedded-preparation-failure';

    const failed = await consume(engine.start(invalidDefinition, {
      policy: fixture.policy,
      runId,
    }));
    expect(failed.result.status).toBe('failed');
    expect((await consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId,
    }))).result.status).toBe('completed');
  });

  it('fails binding resolution before any stage starts', async () => {
    const fixture = await createRuntime();
    const runtime: EvaluationEngineRuntime = {
      ...fixture.runtime,
      bindings: {
        ...fixture.runtime.bindings,
        resolveEvaluator() { throw new Error('missing evaluator binding'); },
      },
    };
    const result = await createEvaluationEngine(runtime).start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-partial-failure',
    }).result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected a failed result.');
    expect(result.error.code).toBe('EVAL_DEFINITION_RUNTIME_RESOLUTION_FAILED');
    expect(result.artifacts).toBeUndefined();
    expect(result.report).toBeUndefined();
  });

  it('isolates concurrent cancellation, events, and evidence', async () => {
    const fixture = await createRuntime();
    const engine = createEvaluationEngine(fixture.runtime);
    const cancelled = new AbortController();
    cancelled.abort(new Error('host cancellation'));
    const left = consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-cancelled',
      signal: cancelled.signal,
      eventBufferCapacity: 128,
    }));
    const right = consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-independent',
      eventBufferCapacity: 128,
    }));

    const [cancelledResult, completedResult] = await Promise.all([left, right]);
    expect(cancelledResult.result.status).toBe('cancelled');
    expect(completedResult.result.status).toBe('completed');
    expect(cancelledResult.events.every((event) => (
      event.runId === 'embedded-cancelled'
    ))).toBe(true);
    expect(completedResult.events.every((event) => (
      event.runId === 'embedded-independent'
    ))).toBe(true);
    expect(cancelledResult.events[0]?.sequence).toBe(0);
    expect(completedResult.events[0]?.sequence).toBe(0);
    expect((await consume(engine.start(fixture.definition, {
      policy: fixture.policy,
      runId: 'embedded-cancelled',
    }))).result.status).toBe('completed');
  });
});
