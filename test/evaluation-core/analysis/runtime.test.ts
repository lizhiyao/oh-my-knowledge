import { describe, expect, it } from 'vitest';
import {
  digestArtifactPayload,
  digestCanonicalJson,
  effectiveExecutionBundleTrust,
  parseAnalysisBundle,
  parseEvaluationBundle,
  parseEvaluationReport,
  schemaIdentityKey,
  verifyAnalysisBundle,
  verifyDecisionResult,
  verifyEvaluationBundle,
  type AnalysisBundle,
  type DecisionResult,
  type EvaluationBundle,
  type RuntimeIdentity,
  type Sha256Digest,
} from '../../../src/evaluation-core/contracts/index.js';
import {
  prepareEvaluationPlan,
  type AnalysisRuntimeRequirement,
  type PreparationRuntime,
} from '../../../src/evaluation-core/compiler/index.js';
import {
  executeRunPlanSource,
  InMemoryRuntimeEventSequencer,
  type ExecutionClock,
  type ExecutionExecutor,
} from '../../../src/evaluation-core/execution/index.js';
import {
  evaluateExecutionBundleSource,
  type EvaluationEvaluator,
} from '../../../src/evaluation-core/evaluation/index.js';
import {
  analyzeEvaluationBundle,
  analyzeEvaluationBundleSource,
  BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  decideAnalysis,
  decideAnalysisSource,
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function analysisAwareRuntime(): PreparationRuntime {
  const base = testRuntime();
  const schemaValidators = new Map([
    ...base.schemaValidators,
    ...createBuiltinAnalysisSchemaValidators(),
  ]);
  return {
    schemaValidators,
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
) => void, runtime: PreparationRuntime = analysisAwareRuntime()): Promise<Plan> {
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
  return prepareEvaluationPlan(definition, policy, runtime);
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

function resealDecisionResult(
  source: DecisionResult,
  mutate: (draft: DecisionResult) => void,
): DecisionResult {
  const draft = structuredClone(source);
  mutate(draft);
  const payload: Record<string, unknown> = { ...draft };
  delete payload.decisionDigest;
  draft.decisionDigest = digestCanonicalJson(payload);
  return draft;
}

async function makeAnalysisFixture(
  suffix: string,
  mutate?: Parameters<typeof makePlan>[0],
) {
  const plan = await makePlan(mutate);
  const clock = new FakeClock();
  const eventSequencer = new InMemoryRuntimeEventSequencer();
  const execution = await executeRunPlanSource(plan, {
    executors: new Map([['executor-alias', executor(plan, 'control')]]),
    clock,
    eventSequencer,
  }, { runId: `run-${suffix}`, bundleId: `execution-${suffix}` });
  const evaluation = await evaluateExecutionBundleSource(plan, execution, {
    evaluators: new Map([['exact/v1', evaluator(plan)]]),
    clock,
    eventSequencer,
  }, { runId: `run-${suffix}`, bundleId: `evaluation-${suffix}` });
  const ports = {
    analysisNodes: createBuiltinAnalysisNodes(),
    schemaValidators: createBuiltinAnalysisSchemaValidators(),
    missingPolicies: createBuiltinMissingPolicies(),
    decisionPolicies: createBuiltinDecisionPolicies(),
    clock,
    eventSequencer,
  };
  const analysisSource = await analyzeEvaluationBundleSource(plan, execution, evaluation, ports, {
    runId: `run-${suffix}`,
    bundleId: `analysis-${suffix}`,
  });
  return {
    plan,
    clock,
    eventSequencer,
    execution,
    evaluation,
    ports,
    analysis: analysisSource.bundle,
    analysisSource,
  };
}

async function collectEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('Evaluation Core Analysis and Decision Runtime', () => {
  it('seals parameter defaults and rejects unknown measurement parameters', async () => {
    const plan = await makePlan();
    expect(plan.analysis.analysisGraph.nodes[0].parameters).toEqual({});
    expect(plan.decision.decisionPolicy?.parameters).toEqual({ threshold: 0.4, equivalence: 0 });
    await expect(makePlan((definition) => {
      definition.analysisGraph.nodes[0].parameters = { minimumCoverage: 0.8 };
    })).rejects.toMatchObject({ code: 'EVAL_DEFINITION_VALUE_DOMAIN_INVALID' });
  });

  it('rejects progress/v1 over an unsupported hypothesis table during preparation', async () => {
    const base = analysisAwareRuntime();
    const parameterSchema = {
      schemaVersion: 'test.empty-parameters/v1',
      schemaUri: 'urn:test:parameters:empty:v1',
      schemaDigest: digestCanonicalJson({ type: 'object', additionalProperties: false }),
    };
    const schemaValidators = new Map(base.schemaValidators);
    schemaValidators.set(schemaIdentityKey(parameterSchema), {
      schema: parameterSchema,
      parse(value: unknown) {
        if (value === null || Array.isArray(value) || typeof value !== 'object'
            || Object.keys(value).length !== 0) {
          throw new TypeError('Expected empty parameters.');
        }
        return {};
      },
    });
    const producerIdentity: RuntimeIdentity = {
      implementationId: 'test.hypothesis-table/v1',
      version: '1.0.0',
      fingerprint: digestCanonicalJson({ implementationId: 'test.hypothesis-table/v1' }),
      fingerprintBasis: 'content-derived',
      assuranceLevel: 'verified',
      capabilities: {
        capabilityKind: 'analysis-node',
        analysisNodeKinds: ['reducer'],
        inputDomains: [{
          inputKind: 'metric-observations',
          valueTypes: ['boolean'],
          missingPolicyIds: ['exclude/v1'],
        }],
        outputSchema: BUILTIN_HYPOTHESIS_TABLE_SCHEMA,
        parameterSchema,
        inputCardinalities: {
          metricObservations: { min: 1, max: 1 },
          analysisResults: { min: 0, max: 0 },
          comparisons: { min: 0, max: 0 },
        },
        schemas: [],
      },
    };
    const runtime: PreparationRuntime = {
      ...base,
      schemaValidators,
      resolveAnalysis(requirement) {
        if (requirement.requirementKind === 'analysis-node'
            && requirement.implementationId === producerIdentity.implementationId) {
          return { identity: producerIdentity, satisfiesVersionConstraint: true };
        }
        return base.resolveAnalysis(requirement);
      },
    };
    const definition = validDefinition();
    definition.analysisGraph.nodes = [{
      analysisNodeKind: 'reducer',
      nodeId: 'hypothesis-table',
      implementationId: producerIdentity.implementationId,
      inputs: [{ inputKind: 'metric-observations', referenceId: 'correct' }],
      outputResultId: 'hypothesis-table-result',
    }];
    definition.decisionPolicy!.analysisResultIds = ['hypothesis-table-result'];

    await expect(prepareEvaluationPlan(
      definition,
      validPolicy(),
      runtime,
    )).rejects.toMatchObject({ code: 'EVAL_DEFINITION_CAPABILITY_UNSUPPORTED' });
  });

  it('derives a validated AnalysisBundle, decision, and materialized Report', async () => {
    const plan = await makePlan();
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlanSource(plan, {
      executors: new Map([
        ['executor-alias', executor(plan, 'control')],
      ]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-1', bundleId: 'execution-analysis-1' });
    const evaluation = await evaluateExecutionBundleSource(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-1', bundleId: 'evaluation-analysis-1' });
    const ports = {
      analysisNodes: createBuiltinAnalysisNodes(),
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
    };
    const analysisSource = await analyzeEvaluationBundleSource(
      plan,
      execution,
      evaluation,
      ports,
      { runId: 'run-analysis-1', bundleId: 'analysis-1' },
    );
    const analysis = analysisSource.bundle;

    expect(analysis.analysisBundleStatus).toBe('completed');
    expect(analysis.coverage).toMatchObject({ completed: 1, failed: 0 });
    expect(analysis.records[0]).toMatchObject({
      analysisStatus: 'completed',
      resultId: 'correct-rate',
      resultType: 'scalar',
      value: 0.5,
      coverage: { planned: 2, observed: 2, included: 2 },
      runtimeDependencies: [{
        runtimeKind: 'analysis-node',
        referenceId: 'mean-correct',
      }],
    });
    expect(analysis.provenance.trust).toBe('declared');
    expect(parseAnalysisBundle(analysis, plan, execution, evaluation, {
      schemaValidators: ports.schemaValidators,
    })).toMatchObject({
      bundle: analysis,
      planVerification: { provenanceTrustStatus: 'indeterminate' },
    });

    const decisionRun = startDecision(
      plan,
      execution,
      evaluation,
      analysisSource,
      ports,
      { runId: 'run-analysis-1' },
    );
    const decisionSource = await decisionRun.source;
    const decision = decisionSource?.result;
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
      analysisSource,
      decisionSource,
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
    expect(report.provenance.trust).toBe('declared');
    expect(parseEvaluationReport(
      report,
      plan,
      execution,
      evaluation,
      analysisSource,
      decisionSource,
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
      analysisSource,
      decisionSource,
    )).toEqual(withUris);

    const foreignRoot = structuredClone(report);
    foreignRoot.runContractDigest = `sha256:${'f'.repeat(64)}`;
    foreignRoot.reportDigest = digestArtifactPayload(foreignRoot, 'reportDigest');
    expect(() => parseEvaluationReport(
      foreignRoot,
      plan,
      execution,
      evaluation,
      analysisSource,
      decisionSource,
    )).toThrowError(expect.objectContaining({
      code: 'EVALUATION_REPORT_PLAN_MISMATCH',
    }));

    const builtinPolicy = ports.decisionPolicies.get('progress/v1');
    if (builtinPolicy === undefined) throw new Error('missing DecisionPolicy');
    const failedDecision = await decideAnalysis(
      plan,
      execution,
      evaluation,
      analysisSource,
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

  it('caps Analysis trust only with Runtime dependencies that were actually used', async () => {
    const preparation = analysisAwareRuntime();
    const builtinPolicy = createBuiltinMissingPolicies().get('exclude/v1');
    if (builtinPolicy === undefined) throw new Error('missing builtin MissingPolicy');
    const missingPolicyIdentity: RuntimeIdentity = {
      ...structuredClone(builtinPolicy.identity),
      assuranceLevel: 'unknown',
    };
    const runtime: PreparationRuntime = {
      ...preparation,
      resolveAnalysis(requirement) {
        if (requirement.requirementKind === 'missing-policy') {
          return { identity: missingPolicyIdentity, satisfiesVersionConstraint: true };
        }
        return preparation.resolveAnalysis(requirement);
      },
    };
    const plan = await makePlan(undefined, runtime);
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlanSource(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-dependencies', bundleId: 'execution-analysis-dependencies' });
    const observedEvaluation = await evaluateExecutionBundleSource(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-observed', bundleId: 'evaluation-analysis-observed' });
    const missingEvaluation = await evaluateExecutionBundleSource(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan, true)]]),
      clock,
      eventSequencer,
    }, {
      runId: 'run-analysis-missing-dependency',
      bundleId: 'evaluation-analysis-missing-dependency',
    });
    const ports = {
      analysisNodes: createBuiltinAnalysisNodes(),
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
      missingPolicies: new Map([['exclude/v1', {
        ...builtinPolicy,
        identity: missingPolicyIdentity,
      }]]),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
    };
    const observed = await analyzeEvaluationBundleSource(
      plan,
      execution,
      observedEvaluation,
      ports,
      { runId: 'run-analysis-observed', bundleId: 'analysis-observed' },
    );
    const missing = await analyzeEvaluationBundleSource(
      plan,
      execution,
      missingEvaluation,
      ports,
      { runId: 'run-analysis-missing-dependency', bundleId: 'analysis-missing-dependency' },
    );

    expect(observed.bundle.records[0].runtimeDependencies).toEqual([{
      runtimeKind: 'analysis-node',
      referenceId: 'mean-correct',
    }]);
    expect(observed.bundle.provenance.trust).toBe('declared');
    expect(missing.bundle.records[0].runtimeDependencies).toEqual([
      { runtimeKind: 'analysis-node', referenceId: 'mean-correct' },
      { runtimeKind: 'missing-policy', referenceId: 'exclude/v1' },
    ]);
    expect(missing.bundle.provenance.trust).toBe('unknown');
  });

  it('rejects a fully resealed AnalysisBundle with a forged Runtime identity', async () => {
    const plan = await makePlan();
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlanSource(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-forge', bundleId: 'execution-analysis-forge' });
    const evaluation = await evaluateExecutionBundleSource(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-forge', bundleId: 'evaluation-analysis-forge' });
    const ports = {
      analysisNodes: createBuiltinAnalysisNodes(),
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
    };
    const analysisSource = await analyzeEvaluationBundleSource(
      plan,
      execution,
      evaluation,
      ports,
      { runId: 'run-analysis-forge', bundleId: 'analysis-forge' },
    );
    const analysis = analysisSource.bundle;
    const forged = resealAnalysisBundle(analysis, (draft) => {
      draft.records[0].implementation.fingerprint = 'forged-analysis-runtime';
    });

    expect(() => parseAnalysisBundle(forged, plan, execution, evaluation, {
      schemaValidators: ports.schemaValidators,
    })).toThrow(
      /sealed node and Runtime binding/,
    );
  });

  it('does not treat resealed Analysis or Decision artifacts as authenticated sources', async () => {
    const fixture = await makeAnalysisFixture('transported-authenticity');
    const resealedAnalysis = resealAnalysisBundle(fixture.analysis, (draft) => {
      draft.bundleId = 'analysis-transported-resealed';
    });
    const transportedAnalysis = parseAnalysisBundle(
      resealedAnalysis,
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      { schemaValidators: fixture.ports.schemaValidators },
    );
    const gated = await decideAnalysis(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      transportedAnalysis,
      fixture.ports,
      { runId: 'run-transported-analysis' },
    );

    expect(transportedAnalysis.planVerification.provenanceTrustStatus).toBe('indeterminate');
    expect(gated).toMatchObject({
      decisionStatus: 'not-decided',
      reasonCodes: expect.arrayContaining(['decision-analysis-provenance-indeterminate']),
    });

    const authenticDecision = await decideAnalysisSource(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      fixture.analysisSource,
      fixture.ports,
      { runId: 'run-authentic-decision' },
    );
    if (authenticDecision === undefined
        || authenticDecision.result.decisionStatus !== 'decided') {
      throw new Error('missing directional Decision source');
    }
    const resealedDecision = resealDecisionResult(authenticDecision.result, (draft) => {
      if (draft.decisionStatus !== 'decided') throw new Error('unexpected Decision status');
      draft.verdict = draft.verdict === 'PROGRESS' ? 'NO-GO' : 'PROGRESS';
    });
    expect(() => verifyDecisionResult(
      resealedDecision,
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      fixture.analysisSource,
    )).toThrowError(expect.objectContaining({
      code: 'DECISION_RESULT_VERIFICATION_GATE_FAILED',
    }));
  });

  it('reuses durable upstream stages only while their stage Plans remain current', async () => {
    const fixture = await makeAnalysisFixture('stage-scoped-reuse');
    const decisionOnlyPlan = await makePlan((definition) => {
      definition.decisionPolicy = {
        ...definition.decisionPolicy!,
        parameters: { threshold: 0.6 },
      };
    });

    expect(decisionOnlyPlan.execution.executionPlanDigest)
      .toBe(fixture.plan.execution.executionPlanDigest);
    expect(decisionOnlyPlan.evaluation.evaluationPlanDigest)
      .toBe(fixture.plan.evaluation.evaluationPlanDigest);
    expect(decisionOnlyPlan.analysis.analysisPlanDigest)
      .toBe(fixture.plan.analysis.analysisPlanDigest);
    expect(decisionOnlyPlan.decision.decisionPlanDigest)
      .not.toBe(fixture.plan.decision.decisionPlanDigest);
    expect(decisionOnlyPlan.digests.runContractDigest)
      .not.toBe(fixture.plan.digests.runContractDigest);

    const transportedEvaluation = verifyEvaluationBundle(
      structuredClone(fixture.evaluation.bundle),
      decisionOnlyPlan,
      fixture.execution,
      {
        verifiedProvenanceBundleDigests: new Set([
          fixture.evaluation.bundle.bundleDigest as Sha256Digest,
        ]),
        executionSourceTrust: effectiveExecutionBundleTrust(fixture.execution),
      },
    );
    const transportedAnalysis = verifyAnalysisBundle(
      structuredClone(fixture.analysis),
      decisionOnlyPlan,
      fixture.execution,
      transportedEvaluation,
      { schemaValidators: fixture.ports.schemaValidators },
      {
        verifiedProvenanceBundleDigests: new Set([
          fixture.analysis.bundleDigest as Sha256Digest,
        ]),
      },
    );
    const decision = await decideAnalysisSource(
      decisionOnlyPlan,
      fixture.execution,
      transportedEvaluation,
      transportedAnalysis,
      fixture.ports,
      { runId: 'run-stage-scoped-reuse' },
    );
    expect(decision?.result.decisionStatus).toBe('decided');

    const analysisOnlyPlan = await makePlan((definition) => {
      definition.analysisGraph.analysisMode = 'exploratory';
    });
    const reusableEvaluation = verifyEvaluationBundle(
      structuredClone(fixture.evaluation.bundle),
      analysisOnlyPlan,
      fixture.execution,
      {
        verifiedProvenanceBundleDigests: new Set([
          fixture.evaluation.bundle.bundleDigest as Sha256Digest,
        ]),
        executionSourceTrust: effectiveExecutionBundleTrust(fixture.execution),
      },
    );
    expect(reusableEvaluation.bundle.bundleDigest).toBe(fixture.evaluation.bundle.bundleDigest);
    expect(() => verifyAnalysisBundle(
      structuredClone(fixture.analysis),
      analysisOnlyPlan,
      fixture.execution,
      reusableEvaluation,
      { schemaValidators: fixture.ports.schemaValidators },
    )).toThrowError(expect.objectContaining({
      code: 'ANALYSIS_BUNDLE_PLAN_MISMATCH',
    }));
    expect(() => startDecision(
      analysisOnlyPlan,
      fixture.execution,
      reusableEvaluation,
      fixture.analysisSource,
      fixture.ports,
      { runId: 'run-stale-analysis' },
    )).toThrowError(expect.objectContaining({
      code: 'ANALYSIS_BUNDLE_PLAN_MISMATCH',
    }));
  });

  it('validates completed outputs with an independent Core validator', async () => {
    const fixture = await makeAnalysisFixture('independent-validator');
    const original = fixture.ports.analysisNodes.get('descriptive.rate/v1');
    if (original === undefined) throw new Error('missing builtin Analysis Runtime');
    expect(original.identity).toMatchObject({
      fingerprintBasis: 'self-reported',
      assuranceLevel: 'declared',
    });
    const malicious = {
      identity: original.identity,
      outputSchema: original.outputSchema,
      async openRun() {
        return {
          async execute() {
            return {
              analysisStatus: 'completed' as const,
              resultType: 'scalar' as const,
              value: { forged: true },
            };
          },
          dispose() {},
        };
      },
    };
    const analysisSource = await analyzeEvaluationBundleSource(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      {
        ...fixture.ports,
        analysisNodes: new Map([['descriptive.rate/v1', malicious]]),
      },
      { runId: 'run-malicious-validator', bundleId: 'analysis-malicious-validator' },
    );
    const analysis = analysisSource.bundle;

    expect(analysis).toMatchObject({
      analysisBundleStatus: 'failed',
      records: [{
        analysisStatus: 'failed',
        error: { code: 'analysis-runtime-failed' },
      }],
    });

    const forged = resealAnalysisBundle(fixture.analysis, (draft) => {
      const record = draft.records[0];
      if (record.analysisStatus !== 'completed') throw new Error('expected completed record');
      record.value = { forged: true };
    });
    expect(() => parseAnalysisBundle(
      forged,
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      { schemaValidators: fixture.ports.schemaValidators },
    )).toThrow(/sealed output schema/);
  });

  it('binds completed output metadata to sealed Analysis facts', async () => {
    const fixture = await makeAnalysisFixture('contextual-validator', (definition) => {
      definition.dataset.samples.push({
        ...structuredClone(definition.dataset.samples[0]),
        sampleId: 'sample-2',
        input: { question: 'Q2', cohort: 'b' },
      });
      definition.analysisGraph.nodes = [{
        analysisNodeKind: 'estimator',
        nodeId: 'bootstrap-correct',
        implementationId: 'bootstrap.mean-percentile/v1',
        inputs: [{ inputKind: 'metric-observations', referenceId: 'correct' }],
        outputResultId: 'correct-interval',
        parameters: { resamples: 64, alpha: 0.1 },
      }];
      definition.decisionPolicy!.analysisResultIds = ['correct-interval'];
    });
    const original = fixture.ports.analysisNodes.get('bootstrap.mean-percentile/v1');
    if (original === undefined) throw new Error('missing builtin Analysis Runtime');
    const malicious = {
      identity: original.identity,
      outputSchema: original.outputSchema,
      async openRun() {
        return {
          async execute() {
            return {
              analysisStatus: 'completed' as const,
              resultType: 'interval' as const,
              value: {
                estimate: 0.5,
                lower: 0,
                upper: 1,
                confidenceLevel: 0.95,
                resamples: 1_000,
                unitCount: 2,
                method: 'percentile',
              },
            };
          },
          dispose() {},
        };
      },
    };
    const analysis = await analyzeEvaluationBundle(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      {
        ...fixture.ports,
        analysisNodes: new Map([['bootstrap.mean-percentile/v1', malicious]]),
      },
      { runId: 'run-contextual-validator', bundleId: 'analysis-contextual-validator' },
    );

    expect(analysis).toMatchObject({
      analysisBundleStatus: 'failed',
      records: [{
        analysisStatus: 'failed',
        error: { code: 'analysis-runtime-failed' },
      }],
    });

    const wrongUnitCount = {
      identity: original.identity,
      outputSchema: original.outputSchema,
      async openRun() {
        return {
          async execute() {
            return {
              analysisStatus: 'completed' as const,
              resultType: 'interval' as const,
              value: {
                estimate: 0.5,
                lower: 0,
                upper: 1,
                confidenceLevel: 0.9,
                resamples: 64,
                unitCount: 999,
                method: 'percentile',
              },
            };
          },
          dispose() {},
        };
      },
    };
    const unitCountAnalysis = await analyzeEvaluationBundle(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      {
        ...fixture.ports,
        analysisNodes: new Map([['bootstrap.mean-percentile/v1', wrongUnitCount]]),
      },
      { runId: 'run-unit-count-validator', bundleId: 'analysis-unit-count-validator' },
    );
    expect(unitCountAnalysis).toMatchObject({
      analysisBundleStatus: 'failed',
      records: [{
        analysisStatus: 'failed',
        error: { code: 'analysis-runtime-failed' },
      }],
    });

    const forged = resealAnalysisBundle(fixture.analysis, (draft) => {
      const record = draft.records[0];
      if (record.analysisStatus !== 'completed'
          || record.value === null
          || Array.isArray(record.value)
          || typeof record.value !== 'object') {
        throw new Error('expected completed interval record');
      }
      record.value.resamples = 1_000;
      record.value.confidenceLevel = 0.95;
    });
    expect(() => parseAnalysisBundle(
      forged,
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      { schemaValidators: fixture.ports.schemaValidators },
    )).toThrow(/sealed output schema/);

    const forgedUnitCount = resealAnalysisBundle(fixture.analysis, (draft) => {
      const record = draft.records[0];
      if (record.analysisStatus !== 'completed'
          || record.value === null
          || Array.isArray(record.value)
          || typeof record.value !== 'object') {
        throw new Error('expected completed interval record');
      }
      record.value.unitCount = 999;
    });
    expect(() => parseAnalysisBundle(
      forgedUnitCount,
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      { schemaValidators: fixture.ports.schemaValidators },
    )).toThrow(/sealed output schema/);
  });

  it('rejects extra provenance parents even when the bundle is fully resealed', async () => {
    const fixture = await makeAnalysisFixture('provenance-parent');
    const forged = resealAnalysisBundle(fixture.analysis, (draft) => {
      draft.provenance.parentDigests.push(`sha256:${'f'.repeat(64)}`);
    });

    expect(() => parseAnalysisBundle(
      forged,
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      { schemaValidators: fixture.ports.schemaValidators },
    )).toThrow(/exactly one source EvaluationBundle/);

    const upgraded = resealAnalysisBundle(fixture.analysis, (draft) => {
      draft.provenance.trust = 'verified';
    });
    expect(() => parseAnalysisBundle(
      upgraded,
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      { schemaValidators: fixture.ports.schemaValidators },
    )).toThrow(/cannot upgrade trust/);
  });

  it('closes Analysis, Decision, and Report streams when event sequencing throws', async () => {
    const fixture = await makeAnalysisFixture('event-boundary');
    const throwingSequencer = {
      next(): number { throw new Error('sequencer unavailable'); },
    };

    const analysisRun = startAnalysis(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      { ...fixture.ports, eventSequencer: throwingSequencer },
      { runId: 'run-analysis-event-fault', bundleId: 'analysis-event-fault' },
    );
    const analysisEvents = collectEvents(analysisRun.events);
    await expect(analysisRun.result).rejects.toThrow(/sequencer unavailable/);
    await expect(analysisEvents).resolves.toEqual([]);

    const decisionRun = startDecision(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      fixture.analysisSource,
      { ...fixture.ports, eventSequencer: throwingSequencer },
      { runId: 'run-decision-event-fault' },
    );
    const decisionEvents = collectEvents(decisionRun.events);
    await expect(decisionRun.result).rejects.toThrow(/sequencer unavailable/);
    await expect(decisionEvents).resolves.toEqual([]);

    const reportRun = startReportMaterialization(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      fixture.analysisSource,
      undefined,
      { ...fixture.ports, eventSequencer: throwingSequencer },
      { runId: 'run-report-event-fault', reportId: 'report-event-fault' },
    );
    const reportEvents = collectEvents(reportRun.events);
    await expect(reportRun.result).rejects.toThrow(/sequencer unavailable/);
    await expect(reportEvents).resolves.toEqual([]);
  });

  it('passes only the explicitly sealed comparison family to DecisionPolicy', async () => {
    const fixture = await makeAnalysisFixture('comparison-family', (definition) => {
      definition.dataset.samples.push({
        ...structuredClone(definition.dataset.samples[0]),
        sampleId: 'sample-2',
        input: { question: 'Q2', cohort: 'b' },
      });
      definition.targets.push({
        ...structuredClone(definition.targets[1]),
        targetId: 'unrelated-treatment',
      });
      definition.comparisons.push({
        comparisonId: 'unrelated-comparison',
        controlTargetId: 'control',
        treatmentTargetIds: ['unrelated-treatment'],
        metricIds: ['correct'],
      });
      definition.comparisons[0].treatmentTargetIds.push('unrelated-treatment');
      definition.experiment.sampling = {
        experimentalUnit: 'sample',
        repeatedMeasures: false,
        resamplingUnit: 'paired-block',
        estimatorId: 'bootstrap.paired-difference-percentile/v1',
        seedCoupling: 'shared-within-block',
        pairingKey: '/input/cohort',
      };
      definition.analysisGraph.nodes = [{
        analysisNodeKind: 'estimator',
        nodeId: 'treatment-effect',
        implementationId: 'bootstrap.paired-difference-percentile/v1',
        inputs: [
          { inputKind: 'metric-observations', referenceId: 'correct' },
          {
            inputKind: 'comparison',
            referenceId: 'control-vs-treatment',
            treatmentTargetId: 'treatment',
            metricId: 'correct',
          },
        ],
        outputResultId: 'treatment-effect-result',
        parameters: { resamples: 64, alpha: 0.1 },
      }];
      definition.decisionPolicy!.analysisResultIds = ['treatment-effect-result'];
      definition.decisionPolicy!.comparisonFamily = [{
        comparisonId: 'control-vs-treatment',
        treatmentTargetId: 'treatment',
        metricId: 'correct',
        analysisResultId: 'treatment-effect-result',
      }];
    });
    const builtinPolicy = fixture.ports.decisionPolicies.get('progress/v1');
    if (builtinPolicy === undefined) throw new Error('missing builtin DecisionPolicy');
    let receivedContrasts: unknown[] = [];
    const decision = await decideAnalysis(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      fixture.analysisSource,
      {
        ...fixture.ports,
        decisionPolicies: new Map([['progress/v1', {
          identity: builtinPolicy.identity,
          async decide(context) {
            receivedContrasts = [...context.contrasts];
            return { decisionStatus: 'decided' as const, verdict: 'PROGRESS' };
          },
        }]]),
      },
      { runId: 'run-comparison-family-decision' },
    );

    expect(decision?.decisionStatus).toBe('decided');
    expect(receivedContrasts).toEqual([{
      analysisResultId: 'treatment-effect-result',
      comparisonId: 'control-vs-treatment',
      controlTargetId: 'control',
      treatmentTargetId: 'treatment',
      metricId: 'correct',
    }]);
  });

  it('binds AnalysisBundle to the exact EvaluationBundle content', async () => {
    const plan = await makePlan();
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlanSource(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-source', bundleId: 'execution-analysis-source' });
    const evaluation = await evaluateExecutionBundleSource(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-source', bundleId: 'evaluation-analysis-source' });
    const ports = {
      analysisNodes: createBuiltinAnalysisNodes(),
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
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
    const replacement = resealEvaluationBundle(evaluation.bundle, (draft) => {
      draft.bundleId = 'evaluation-replacement';
    });
    const replacementSource = parseEvaluationBundle(replacement, plan, execution);

    expect(() => parseAnalysisBundle(analysis, plan, execution, replacementSource, {
      schemaValidators: ports.schemaValidators,
    })).toThrow(
      /parent identities/,
    );

    const foreignExecution = await executeRunPlanSource(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-foreign', bundleId: 'execution-analysis-foreign' });
    const foreignEvaluation = await evaluateExecutionBundleSource(plan, foreignExecution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-foreign', bundleId: 'evaluation-analysis-foreign' });
    expect(() => parseAnalysisBundle(analysis, plan, execution, foreignEvaluation, {
      schemaValidators: ports.schemaValidators,
    })).toThrowError(expect.objectContaining({
      code: 'EVALUATION_BUNDLE_SOURCE_MISMATCH',
    }));
  });

  it('returns an inconclusive decision instead of converting missing observations to zero', async () => {
    const plan = await makePlan();
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlanSource(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-missing', bundleId: 'execution-analysis-missing' });
    const evaluation = await evaluateExecutionBundleSource(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan, true)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-missing', bundleId: 'evaluation-analysis-missing' });
    const ports = {
      analysisNodes: createBuiltinAnalysisNodes(),
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
    };
    const analysisSource = await analyzeEvaluationBundleSource(
      plan,
      execution,
      evaluation,
      ports,
      { runId: 'run-analysis-missing', bundleId: 'analysis-missing' },
    );
    const analysis = analysisSource.bundle;
    const decision = await decideAnalysis(
      plan,
      execution,
      evaluation,
      analysisSource,
      ports,
      { runId: 'run-analysis-missing' },
    );

    expect(analysis.records[0]).toMatchObject({
      analysisStatus: 'inconclusive',
      coverage: { observed: 0, missing: 2, included: 0 },
      runtimeDependencies: [
        { runtimeKind: 'analysis-node', referenceId: 'mean-correct' },
        { runtimeKind: 'missing-policy', referenceId: 'exclude/v1' },
      ],
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
      { schemaValidators: ports.schemaValidators },
    )).toThrow(/source observation universe/);
    const forgedDependencies = resealAnalysisBundle(analysis, (draft) => {
      draft.records[0].runtimeDependencies = draft.records[0].runtimeDependencies.filter(
        (dependency) => dependency.runtimeKind !== 'missing-policy',
      );
    });
    expect(() => parseAnalysisBundle(
      forgedDependencies,
      plan,
      execution,
      evaluation,
      { schemaValidators: ports.schemaValidators },
    )).toThrow(/MissingPolicy dependency/);
    const omittedNodeDependency = resealAnalysisBundle(analysis, (draft) => {
      draft.records[0].runtimeDependencies = draft.records[0].runtimeDependencies.filter(
        (dependency) => dependency.runtimeKind !== 'analysis-node',
      );
    });
    expect(() => parseAnalysisBundle(
      omittedNodeDependency,
      plan,
      execution,
      evaluation,
      { schemaValidators: ports.schemaValidators },
    )).toThrow(/MissingPolicy rejections/);
    expect(decision).toMatchObject({
      decisionStatus: 'not-decided',
      reasonCodes: expect.arrayContaining(['decision-analysis-result-unavailable']),
    });
  });

  it('materializes a cancelled partial AnalysisBundle for a pre-aborted signal', async () => {
    const plan = await makePlan();
    const clock = new FakeClock();
    const eventSequencer = new InMemoryRuntimeEventSequencer();
    const execution = await executeRunPlanSource(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-cancel', bundleId: 'execution-analysis-cancel' });
    const evaluation = await evaluateExecutionBundleSource(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
    }, { runId: 'run-analysis-cancel', bundleId: 'evaluation-analysis-cancel' });
    const controller = new AbortController();
    controller.abort();
    const run = startAnalysis(plan, execution, evaluation, {
      analysisNodes: createBuiltinAnalysisNodes(),
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
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
    expect(analysis.records[0]).toMatchObject({
      analysisStatus: 'not-evaluated',
      runtimeDependencies: [],
    });
    expect(analysis.coverage.notStarted).toBe(1);
    expect(analysis.provenance.trust).toBe('verified');
  });

  it('keeps in-flight Analysis and Decision cancellation authoritative', async () => {
    const fixture = await makeAnalysisFixture('in-flight-cancel');
    const originalNode = fixture.ports.analysisNodes.get('descriptive.rate/v1');
    const originalPolicy = fixture.ports.decisionPolicies.get('progress/v1');
    if (originalNode === undefined || originalPolicy === undefined) throw new Error('missing builtin');

    const analysisController = new AbortController();
    const analysisEntered = deferred();
    const analysisRun = startAnalysis(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      {
        ...fixture.ports,
        analysisNodes: new Map([['descriptive.rate/v1', {
          identity: originalNode.identity,
          outputSchema: originalNode.outputSchema,
          async openRun() {
            return {
              execute: async ({ signal }) => {
                analysisEntered.resolve();
                return new Promise((_, reject) => {
                  signal.addEventListener('abort', () => reject(new Error('port aborted')), { once: true });
                });
              },
              dispose() {},
            };
          },
        }]]),
      },
      {
        runId: 'run-in-flight-analysis-cancel',
        bundleId: 'analysis-in-flight-cancel',
        signal: analysisController.signal,
      },
    );
    await analysisEntered.promise;
    expect(() => analysisController.abort()).not.toThrow();
    const cancelledAnalysis = await analysisRun.result;
    expect(cancelledAnalysis).toMatchObject({
      analysisBundleStatus: 'cancelled',
      records: [{
        analysisStatus: 'not-evaluated',
        runtimeDependencies: [{
          runtimeKind: 'analysis-node',
          referenceId: 'mean-correct',
        }],
      }],
      provenance: { trust: 'declared' },
    });

    const decisionController = new AbortController();
    const decisionEntered = deferred();
    const decisionRun = startDecision(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      fixture.analysisSource,
      {
        ...fixture.ports,
        decisionPolicies: new Map([['progress/v1', {
          identity: originalPolicy.identity,
          decide: async ({ signal }) => {
            decisionEntered.resolve();
            return new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(new Error('policy aborted')), { once: true });
            });
          },
        }]]),
      },
      { runId: 'run-in-flight-decision-cancel', signal: decisionController.signal },
    );
    await decisionEntered.promise;
    expect(() => decisionController.abort()).not.toThrow();
    await expect(decisionRun.result).resolves.toMatchObject({
      decisionStatus: 'not-decided',
      reasonCodes: ['decision-cancelled'],
    });
  });

  it('discards successful port results that arrive after cancellation', async () => {
    const fixture = await makeAnalysisFixture('late-success-cancel');
    const originalNode = fixture.ports.analysisNodes.get('descriptive.rate/v1');
    const originalPolicy = fixture.ports.decisionPolicies.get('progress/v1');
    if (originalNode === undefined || originalPolicy === undefined) throw new Error('missing builtin');

    const analysisController = new AbortController();
    const analysisEntered = deferred();
    const releaseAnalysis = deferred();
    const analysisRun = startAnalysis(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      {
        ...fixture.ports,
        analysisNodes: new Map([['descriptive.rate/v1', {
          identity: originalNode.identity,
          outputSchema: originalNode.outputSchema,
          async openRun() {
            return {
              async execute() {
                analysisEntered.resolve();
                await releaseAnalysis.promise;
                return { analysisStatus: 'completed' as const, resultType: 'scalar' as const, value: 1 };
              },
              dispose() {},
            };
          },
        }]]),
      },
      {
        runId: 'run-late-analysis-cancel',
        bundleId: 'analysis-late-cancel',
        signal: analysisController.signal,
      },
    );
    await analysisEntered.promise;
    expect(() => analysisController.abort()).not.toThrow();
    releaseAnalysis.resolve();
    await expect(analysisRun.result).resolves.toMatchObject({
      analysisBundleStatus: 'cancelled',
      records: [{ analysisStatus: 'not-evaluated' }],
    });

    const decisionController = new AbortController();
    const decisionEntered = deferred();
    const releaseDecision = deferred();
    const decisionRun = startDecision(
      fixture.plan,
      fixture.execution,
      fixture.evaluation,
      fixture.analysisSource,
      {
        ...fixture.ports,
        decisionPolicies: new Map([['progress/v1', {
          identity: originalPolicy.identity,
          async decide() {
            decisionEntered.resolve();
            await releaseDecision.promise;
            return { decisionStatus: 'decided' as const, verdict: 'PROGRESS' };
          },
        }]]),
      },
      { runId: 'run-late-decision-cancel', signal: decisionController.signal },
    );
    await decisionEntered.promise;
    expect(() => decisionController.abort()).not.toThrow();
    releaseDecision.resolve();
    await expect(decisionRun.result).resolves.toMatchObject({
      decisionStatus: 'not-decided',
      reasonCodes: ['decision-cancelled'],
    });
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
    const execution = await executeRunPlanSource(plan, {
      executors: new Map([['executor-alias', executor(plan, 'control')]]),
      clock,
      eventSequencer,
      eventWriter: workingWriter,
    }, { runId: 'run-analysis-writer', bundleId: 'execution-analysis-writer' });
    const evaluation = await evaluateExecutionBundleSource(plan, execution, {
      evaluators: new Map([['exact/v1', evaluator(plan)]]),
      clock,
      eventSequencer,
      eventWriter: workingWriter,
    }, { runId: 'run-analysis-writer', bundleId: 'evaluation-analysis-writer' });
    const analysisSource = await analyzeEvaluationBundleSource(plan, execution, evaluation, {
      analysisNodes: createBuiltinAnalysisNodes(),
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
      eventWriter: { write: async () => { throw new Error('writer down'); } },
    }, { runId: 'run-analysis-writer', bundleId: 'analysis-writer' });
    const analysis = analysisSource.bundle;

    expect(analysis.analysisBundleStatus).toBe('failed');
    expect(analysis.terminationReasonCode).toBe('analysis-event-writer-failed');
    expect(analysis.coverage.failed).toBe(0);
    expect(analysis.records[0].analysisStatus).toBe('not-evaluated');

    const failedPorts = {
      analysisNodes: createBuiltinAnalysisNodes(),
      schemaValidators: createBuiltinAnalysisSchemaValidators(),
      missingPolicies: createBuiltinMissingPolicies(),
      decisionPolicies: createBuiltinDecisionPolicies(),
      clock,
      eventSequencer,
      eventWriter: { write: async () => { throw new Error('writer down'); } },
    };
    const decisionSource = await decideAnalysisSource(
      plan,
      execution,
      evaluation,
      analysisSource,
      failedPorts,
      { runId: 'run-analysis-writer' },
    );
    const decision = decisionSource?.result;
    expect(decision).toMatchObject({
      decisionStatus: 'failed',
      error: { code: 'decision-event-writer-failed', stage: 'infrastructure' },
    });

    const reportRun = startReportMaterialization(
      plan,
      execution,
      evaluation,
      analysisSource,
      decisionSource,
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
