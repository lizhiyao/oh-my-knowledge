import {
  EVALUATION_REPORT_SCHEMA_VERSION,
  DecisionResultSchema,
  EvaluationReportSchema,
  IdentifierSchema,
  canonicalizeJson,
  computeDecisionPolicyDigest,
  deriveEvaluationStatus,
  digestArtifactPayload,
  digestCanonicalJson,
  parseAnalysisBundle,
  parseDecisionResultDocument,
  parseEvaluationBundle,
  parseEvaluationReport,
  parseExecutionBundle,
  parseWireDocument,
  type AnalysisBundle,
  type AnalysisRecord,
  type DecisionResult,
  type EvaluationError,
  type EvaluationReport,
  type JsonValue,
  type Provenance,
  type RuntimeIdentity,
  type Sha256Digest,
} from '../contracts/index.js';
import { deepFreeze, snapshotJson } from '../compiler/immutability.js';
import type { SealedRunPlan } from '../compiler/index.js';
import { BoundedEventStream } from '../runtime/event-stream.js';
import { RuntimeEventEmitter } from '../runtime/events.js';
import {
  AnalysisPortFailure,
  AnalysisRuntimeConfigurationError,
  DecisionPolicyOutputSchema,
  type AnalysisDecisionPolicy,
  type AnalysisRuntimePorts,
  type DecisionOptions,
  type DecisionRun,
  type EvaluationReportMaterializationOptions,
  type EvaluationReportRun,
  type EvaluationReportRunOptions,
} from './types.js';

const EVIDENCE_LEVEL = { unresolvable: 0, partial: 1, complete: 2 } as const;
const TRUST_LEVEL = { untrusted: 0, unknown: 1, declared: 2, verified: 3 } as const;

function configurationError(code: string, message: string): never {
  throw new AnalysisRuntimeConfigurationError(code, message);
}

function validateDecisionOptions(options: DecisionOptions): void {
  if (!IdentifierSchema.safeParse(options.runId).success) {
    configurationError(
      'DECISION_RUNTIME_IDENTIFIER_INVALID',
      'runId must be a valid Evaluation Core identifier.',
    );
  }
  if (options.eventBufferCapacity !== undefined
      && (!Number.isSafeInteger(options.eventBufferCapacity)
        || options.eventBufferCapacity < 1)) {
    configurationError(
      'DECISION_EVENT_BUFFER_CAPACITY_INVALID',
      'eventBufferCapacity must be a positive safe integer.',
    );
  }
}

function minimumTrust(values: readonly Provenance['trust'][]): Provenance['trust'] {
  return [...values].sort((left, right) => TRUST_LEVEL[left] - TRUST_LEVEL[right])[0];
}

function gateReasons(
  plan: SealedRunPlan,
  analysis: AnalysisBundle,
  evidenceStatus: 'complete' | 'partial' | 'unresolvable',
): string[] {
  const policy = plan.decision.decisionPolicy;
  if (policy === undefined) return ['decision-policy-not-declared'];
  const reasons = new Set<string>();
  if (analysis.analysisBundleStatus !== 'completed') {
    reasons.add('analysis-run-not-completed');
  }
  if (EVIDENCE_LEVEL[evidenceStatus] < EVIDENCE_LEVEL[policy.minimumEvidenceStatus]) {
    reasons.add('decision-evidence-gate-failed');
  }
  const recordByResultId = new Map(analysis.records.map((record) => [record.resultId, record]));
  for (const resultId of policy.analysisResultIds) {
    const record = recordByResultId.get(resultId);
    if (record?.analysisStatus !== 'completed') {
      reasons.add('decision-analysis-result-unavailable');
    } else if (record.assumptionChecks.some((check) => check.checkStatus !== 'passed')) {
      reasons.add('decision-assumption-gate-failed');
    }
  }
  const familySize = plan.analysis.comparisons.reduce(
    (total, comparison) => total
      + comparison.treatmentTargetIds.length * comparison.metricIds.length,
    0,
  );
  if (familySize > 1 && policy.multipleComparisonPolicyId === undefined) {
    reasons.add('decision-multiple-comparison-policy-required');
  }
  if (policy.multipleComparisonPolicyId !== undefined) {
    const correction = plan.analysis.analysisGraph.nodes.find((node) => (
      node.analysisNodeKind === 'correction'
      && node.implementationId === policy.multipleComparisonPolicyId
    ));
    const correctionRecord = correction === undefined
      ? undefined
      : recordByResultId.get(correction.outputResultId);
    if (correctionRecord?.analysisStatus !== 'completed'
        || !policy.analysisResultIds.includes(correctionRecord.resultId)) {
      reasons.add('decision-multiple-comparison-result-unavailable');
    }
  }
  return [...reasons].sort();
}

type DecisionPayload = Omit<
  Extract<DecisionResult, { decisionStatus: 'decided' }>,
  'decisionDigest'
> | Omit<
  Extract<DecisionResult, { decisionStatus: 'not-decided' }>,
  'decisionDigest'
> | Omit<
  Extract<DecisionResult, { decisionStatus: 'failed' }>,
  'decisionDigest'
>;

function decisionPayload(input: {
  plan: SealedRunPlan;
  analysis: AnalysisBundle;
  implementation: RuntimeIdentity;
  decidedAt: string;
  output: { decisionStatus: 'decided'; verdict: string }
    | { decisionStatus: 'not-decided'; reasonCodes: readonly string[] }
    | { decisionStatus: 'failed'; error: EvaluationError };
}): DecisionPayload {
  const policy = input.plan.decision.decisionPolicy;
  if (policy === undefined) throw new TypeError('DecisionPolicy is not sealed.');
  const base = {
    decisionPolicyId: policy.decisionPolicyId,
    implementation: input.implementation,
    analysisBundleDigest: input.analysis.bundleDigest,
    decisionPlanDigest: input.plan.decision.decisionPlanDigest,
    policyDigest: computeDecisionPolicyDigest({
      decisionPlanDigest: input.plan.decision.decisionPlanDigest,
      policy,
      runtime: input.implementation,
    }),
    analysisResultIds: [...policy.analysisResultIds].sort(),
    decidedAt: input.decidedAt,
  };
  if (input.output.decisionStatus === 'decided') {
    return { ...base, decisionStatus: 'decided', verdict: input.output.verdict };
  }
  if (input.output.decisionStatus === 'failed') {
    return { ...base, decisionStatus: 'failed', error: input.output.error };
  }
  return {
      ...base,
      decisionStatus: 'not-decided',
      reasonCodes: [...new Set(input.output.reasonCodes)].sort(),
  };
}

interface PreparedDecision {
  execution: ReturnType<typeof parseExecutionBundle>;
  evaluation: ReturnType<typeof parseEvaluationBundle>;
  analysis: AnalysisBundle;
  policy: NonNullable<SealedRunPlan['decision']['decisionPolicy']>;
  runtime: RuntimeIdentity;
  port: AnalysisDecisionPolicy;
}

function prepareDecision(
  plan: SealedRunPlan,
  executionValue: unknown,
  evaluationValue: unknown,
  analysisValue: unknown,
  ports: AnalysisRuntimePorts,
  options: DecisionOptions,
): PreparedDecision | undefined {
  validateDecisionOptions(options);
  const policy = plan.decision.decisionPolicy;
  if (policy === undefined) return undefined;
  if (plan.measurementPolicy.eventDelivery.writerMode === 'required'
      && ports.eventWriter === undefined) {
    configurationError(
      'DECISION_EVENT_WRITER_REQUIRED',
      'Required EventWriter mode needs an injected EventWriter.',
    );
  }
  const execution = parseExecutionBundle(executionValue, plan);
  const evaluation = parseEvaluationBundle(evaluationValue, plan, execution);
  const analysis = parseAnalysisBundle(analysisValue, plan, execution, evaluation);
  const runtime = plan.decision.runtimes.find((candidate) => (
    candidate.runtimeKind === 'decision-policy'
    && candidate.referenceId === policy.decisionPolicyId
  ));
  const port = ports.decisionPolicies.get(policy.implementationId);
  if (runtime === undefined || port === undefined
      || canonicalizeJson(runtime.identity) !== canonicalizeJson(port.identity)) {
    configurationError(
      'DECISION_RUNTIME_IDENTITY_MISMATCH',
      'DecisionPolicy implementation differs from the sealed DecisionPlan.',
    );
  }
  return {
    execution,
    evaluation,
    analysis,
    policy,
    runtime: runtime.identity as RuntimeIdentity,
    port,
  };
}

function makeDecisionResult(input: {
  plan: SealedRunPlan;
  analysis: AnalysisBundle;
  runtime: RuntimeIdentity;
  decidedAt: string;
  output: { decisionStatus: 'decided'; verdict: string }
    | { decisionStatus: 'not-decided'; reasonCodes: readonly string[] }
    | { decisionStatus: 'failed'; error: EvaluationError };
}): DecisionResult {
  const payload = decisionPayload({
    plan: input.plan,
    analysis: input.analysis,
    implementation: input.runtime,
    decidedAt: input.decidedAt,
    output: input.output,
  });
  return deepFreeze(parseDecisionResultDocument(parseWireDocument(DecisionResultSchema, {
    ...payload,
    decisionDigest: digestCanonicalJson(payload),
  })));
}

async function runDecision(
  plan: SealedRunPlan,
  prepared: PreparedDecision,
  ports: AnalysisRuntimePorts,
  options: DecisionOptions,
  stream: BoundedEventStream,
): Promise<DecisionResult> {
  let fatalError: EvaluationError | undefined;
  const events = new RuntimeEventEmitter<
    'decision.started' | 'decision.completed' | 'decision.not-decided' | 'decision.failed',
    'decision-policy',
    'decision.completed' | 'decision.not-decided' | 'decision.failed'
  >(
    ports.clock,
    ports.eventSequencer,
    ports.eventWriter,
    {
      runId: options.runId,
      writerMode: plan.measurementPolicy.eventDelivery.writerMode,
      writerFailureMode: plan.measurementPolicy.eventDelivery.writerFailureMode,
      writerFailureReason: 'decision-event-writer-failed',
      writerFailureError: {
        code: 'decision-event-writer-failed',
        stage: 'infrastructure',
        message: 'Decision EventWriter failed.',
      },
      recoveryEventKinds: [
        'decision.completed',
        'decision.not-decided',
        'decision.failed',
      ],
    },
    stream,
    (_reasonCode, error) => { fatalError = error; },
  );
  const { execution, evaluation, analysis, policy, runtime, port } = prepared;
  await events.emit('decision.started', 'decision-policy', policy.decisionPolicyId, {
    analysisBundleDigest: analysis.bundleDigest,
    decisionPlanDigest: plan.decision.decisionPlanDigest,
  });
  const evidenceStatus = deriveEvaluationStatus({ execution, evaluation, analysis }).evidenceStatus;
  const reasons = gateReasons(plan, analysis, evidenceStatus);
  let output: { decisionStatus: 'decided'; verdict: string }
    | { decisionStatus: 'not-decided'; reasonCodes: readonly string[] }
    | { decisionStatus: 'failed'; error: EvaluationError };
  if (fatalError !== undefined) {
    output = { decisionStatus: 'failed', error: fatalError };
  } else if (reasons.length > 0) {
    output = { decisionStatus: 'not-decided', reasonCodes: reasons };
  } else if (options.signal?.aborted === true) {
    output = { decisionStatus: 'not-decided', reasonCodes: ['decision-cancelled'] };
  } else {
    const recordByResultId = new Map(analysis.records.map(
      (record) => [record.resultId, record],
    ));
    const results = policy.analysisResultIds.map((resultId) => (
      recordByResultId.get(resultId)
    )).filter((record): record is Extract<
      AnalysisRecord,
      { analysisStatus: 'completed' }
    > => record?.analysisStatus === 'completed');
    try {
      output = parseWireDocument(DecisionPolicyOutputSchema, await port.decide(deepFreeze({
        runId: options.runId,
        policy,
        analysisBundleDigest: analysis.bundleDigest as Sha256Digest,
        analysisCoverage: analysis.coverage,
        results,
        comparisons: plan.analysis.comparisons,
        evidenceStatus,
      })));
    } catch {
      output = {
        decisionStatus: 'failed',
        error: {
          code: 'decision-runtime-failed',
          stage: 'analysis',
          message: 'DecisionPolicy implementation failed.',
        },
      };
    }
  }
  const decidedAt = ports.clock.timestamp();
  let result = makeDecisionResult({ plan, analysis, runtime, decidedAt, output });
  const terminalKind = result.decisionStatus === 'decided'
    ? 'decision.completed'
    : result.decisionStatus === 'not-decided'
      ? 'decision.not-decided'
      : 'decision.failed';
  const delivered = await events.emit(
    terminalKind,
    'decision-policy',
    policy.decisionPolicyId,
    result.decisionStatus === 'decided'
      ? { decisionDigest: result.decisionDigest, verdict: result.verdict }
      : result.decisionStatus === 'not-decided'
        ? { decisionDigest: result.decisionDigest, reasonCodes: result.reasonCodes }
        : { decisionDigest: result.decisionDigest, errorCode: result.error.code },
  );
  if (!delivered && fatalError !== undefined) {
    result = makeDecisionResult({
      plan,
      analysis,
      runtime,
      decidedAt,
      output: { decisionStatus: 'failed', error: fatalError },
    });
    await events.emitRecovery(
      'decision.failed',
      'decision-policy',
      policy.decisionPolicyId,
      { decisionDigest: result.decisionDigest, errorCode: fatalError.code },
    );
  }
  events.close();
  return result;
}

export function startDecision(
  plan: SealedRunPlan,
  executionValue: unknown,
  evaluationValue: unknown,
  analysisValue: unknown,
  ports: AnalysisRuntimePorts,
  options: DecisionOptions,
): DecisionRun {
  const prepared = prepareDecision(
    plan,
    executionValue,
    evaluationValue,
    analysisValue,
    ports,
    options,
  );
  const stream = new BoundedEventStream(options.eventBufferCapacity ?? 256);
  if (prepared === undefined) {
    stream.close();
    return { events: stream, result: Promise.resolve(undefined) };
  }
  return {
    events: stream,
    result: runDecision(plan, prepared, ports, options, stream),
  };
}

export async function decideAnalysis(
  plan: SealedRunPlan,
  executionValue: unknown,
  evaluationValue: unknown,
  analysisValue: unknown,
  ports: AnalysisRuntimePorts,
  options: DecisionOptions,
): Promise<DecisionResult | undefined> {
  return startDecision(
    plan,
    executionValue,
    evaluationValue,
    analysisValue,
    ports,
    options,
  ).result;
}

export function materializeEvaluationReport(
  plan: SealedRunPlan,
  executionValue: unknown,
  evaluationValue: unknown,
  analysisValue: unknown,
  decisionValue: unknown | undefined,
  ports: Pick<AnalysisRuntimePorts, 'clock'>,
  options: EvaluationReportMaterializationOptions,
): EvaluationReport {
  if (!IdentifierSchema.safeParse(options.reportId).success) {
    configurationError(
      'EVALUATION_REPORT_IDENTIFIER_INVALID',
      'reportId must be a valid Evaluation Core identifier.',
    );
  }
  const execution = parseExecutionBundle(executionValue, plan);
  const evaluation = parseEvaluationBundle(evaluationValue, plan, execution);
  const analysis = parseAnalysisBundle(analysisValue, plan, execution, evaluation);
  const decision = decisionValue === undefined
    ? undefined
    : parseDecisionResultDocument(decisionValue);
  const status = deriveEvaluationStatus({
    execution,
    evaluation,
    analysis,
    ...(decision !== undefined ? { decision } : {}),
  });
  const parentDigests = [
    execution.bundleDigest,
    evaluation.bundleDigest,
    analysis.bundleDigest,
    ...(decision !== undefined ? [decision.decisionDigest] : []),
  ];
  const payload = {
    schemaVersion: EVALUATION_REPORT_SCHEMA_VERSION,
    reportId: options.reportId,
    runContractDigest: plan.digests.runContractDigest,
    status,
    bundles: [
      {
        bundleKind: 'execution' as const,
        schemaVersion: execution.schemaVersion,
        bundleDigest: execution.bundleDigest,
      },
      {
        bundleKind: 'evaluation' as const,
        schemaVersion: evaluation.schemaVersion,
        bundleDigest: evaluation.bundleDigest,
      },
      {
        bundleKind: 'analysis' as const,
        schemaVersion: analysis.schemaVersion,
        bundleDigest: analysis.bundleDigest,
      },
    ],
    ...(decision !== undefined ? { decision } : {}),
    ...(options.summaries !== undefined
      ? { summaries: snapshotJson(options.summaries) as JsonValue }
      : {}),
    ...(options.annotations !== undefined
      ? { annotations: snapshotJson(options.annotations) as JsonValue }
      : {}),
    provenance: {
      provenanceKind: 'derived' as const,
      trust: minimumTrust([
        execution.provenance.trust,
        evaluation.provenance.trust,
        analysis.provenance.trust,
      ]),
      parentDigests,
      facets: { materializedAt: ports.clock.timestamp() },
    },
  };
  const report = parseWireDocument(EvaluationReportSchema, {
    ...payload,
    reportDigest: digestArtifactPayload(
      { ...payload, reportDigest: digestCanonicalJson(null) },
      'reportDigest',
    ),
  });
  return deepFreeze(parseEvaluationReport(
    report,
    plan,
    execution,
    evaluation,
    analysis,
  ));
}

export function startReportMaterialization(
  plan: SealedRunPlan,
  executionValue: unknown,
  evaluationValue: unknown,
  analysisValue: unknown,
  decisionValue: unknown | undefined,
  ports: AnalysisRuntimePorts,
  options: EvaluationReportRunOptions,
): EvaluationReportRun {
  validateDecisionOptions(options);
  if (plan.measurementPolicy.eventDelivery.writerMode === 'required'
      && ports.eventWriter === undefined) {
    configurationError(
      'REPORT_EVENT_WRITER_REQUIRED',
      'Required EventWriter mode needs an injected EventWriter.',
    );
  }
  const report = materializeEvaluationReport(
    plan,
    executionValue,
    evaluationValue,
    analysisValue,
    decisionValue,
    ports,
    options,
  );
  const stream = new BoundedEventStream(options.eventBufferCapacity ?? 256);
  const result = (async (): Promise<EvaluationReport> => {
    let fatalError: EvaluationError | undefined;
    const events = new RuntimeEventEmitter<
      'report.materialized' | 'report.failed',
      'report',
      'report.materialized' | 'report.failed'
    >(
      ports.clock,
      ports.eventSequencer,
      ports.eventWriter,
      {
        runId: options.runId,
        writerMode: plan.measurementPolicy.eventDelivery.writerMode,
        writerFailureMode: plan.measurementPolicy.eventDelivery.writerFailureMode,
        writerFailureReason: 'report-event-writer-failed',
        writerFailureError: {
          code: 'report-event-writer-failed',
          stage: 'infrastructure',
          message: 'Report EventWriter failed.',
        },
        recoveryEventKinds: ['report.materialized', 'report.failed'],
      },
      stream,
      (_reasonCode, error) => { fatalError = error; },
    );
    const delivered = await events.emit(
      'report.materialized',
      'report',
      report.reportId,
      {
        reportDigest: report.reportDigest,
        status: report.status,
      },
    );
    if (!delivered && fatalError !== undefined) {
      await events.emitRecovery(
        'report.failed',
        'report',
        report.reportId,
        { errorCode: fatalError.code },
      );
      events.close();
      throw new AnalysisPortFailure(fatalError);
    }
    events.close();
    return report;
  })();
  return { events: stream, result };
}
