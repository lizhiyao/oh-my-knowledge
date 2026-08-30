import {
  EVALUATION_REPORT_SCHEMA_VERSION,
  DecisionResultSchema,
  EvaluationReportSchema,
  IdentifierSchema,
  assertAnalysisBundleSourceMatchesPlan,
  canonicalizeJson,
  computeDecisionPolicyDigest,
  deriveEvaluationStatus,
  digestArtifactPayload,
  digestCanonicalJson,
  effectiveAnalysisBundleTrust,
  effectiveDecisionResultTrust,
  effectiveEvaluationBundleTrust,
  effectiveExecutionBundleTrust,
  parseDecisionResultDocument,
  parseEvaluationReport,
  parseWireDocument,
  verifyDecisionResult,
  type AnalysisBundle,
  type AnalysisBundleSource,
  type AnalysisRecord,
  type DecisionResult,
  type DecisionResultSource,
  type EvaluationError,
  type EvaluationBundleSource,
  type EvaluationReport,
  type JsonValue,
  type ExecutionBundleSource,
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

function validateEventSequencer(ports: AnalysisRuntimePorts): void {
  if (ports.eventSequencer === undefined) {
    configurationError(
      'ANALYSIS_RUNTIME_EVENT_SEQUENCER_REQUIRED',
      'Decision and Report runtime require a shared per-Run EventSequencer.',
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
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  analysisSource: AnalysisBundleSource,
): string[] {
  const policy = plan.decision.decisionPolicy;
  if (policy === undefined) return ['decision-policy-not-declared'];
  const reasons = new Set<string>();
  const executionVerification = executionSource.planVerification;
  if (executionVerification.provenanceTrustStatus === 'indeterminate') {
    reasons.add('decision-execution-provenance-indeterminate');
  }
  if (executionVerification.cacheReceiptStatus === 'indeterminate') {
    reasons.add('decision-execution-cache-receipt-indeterminate');
  }
  if (executionVerification.invocationBudgetStatus === 'indeterminate') {
    reasons.add('decision-execution-invocation-budget-indeterminate');
  }
  if (executionVerification.providerCostBudgetStatus === 'indeterminate') {
    reasons.add('decision-execution-provider-cost-budget-indeterminate');
  }
  const evaluationVerification = evaluationSource.planVerification;
  if (evaluationVerification.provenanceTrustStatus === 'indeterminate') {
    reasons.add('decision-evaluation-provenance-indeterminate');
  }
  if (evaluationVerification.cacheReceiptStatus === 'indeterminate') {
    reasons.add('decision-evaluation-cache-receipt-indeterminate');
  }
  if (evaluationVerification.invocationBudgetStatus === 'indeterminate') {
    reasons.add('decision-evaluation-invocation-budget-indeterminate');
  }
  if (evaluationVerification.providerCostBudgetStatus === 'indeterminate') {
    reasons.add('decision-evaluation-provider-cost-budget-indeterminate');
  }
  if (analysisSource.planVerification.provenanceTrustStatus === 'indeterminate') {
    reasons.add('decision-analysis-provenance-indeterminate');
  }
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
  const family = policy.comparisonFamily ?? [];
  const familySize = family.length;
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
    } else {
      const value = correctionRecord.value;
      const valueObject = value !== null && !Array.isArray(value) && typeof value === 'object'
        ? value as Record<string, JsonValue>
        : undefined;
      const hypotheses = valueObject?.hypotheses;
      const hypothesisIds = Array.isArray(hypotheses)
        ? hypotheses.flatMap((entry) => (
          entry !== null && !Array.isArray(entry) && typeof entry === 'object'
            && typeof (entry as Record<string, JsonValue>).hypothesisId === 'string'
            ? [(entry as Record<string, JsonValue>).hypothesisId as string]
            : []
        )).sort()
        : [];
      const hypothesisMembers = family.filter(
        (member): member is typeof member & { hypothesisId: string } => (
          'hypothesisId' in member
        ),
      );
      const expectedIds = hypothesisMembers.map((member) => member.hypothesisId).sort();
      if (valueObject?.familySize !== familySize
          || hypothesisMembers.length !== familySize
          || canonicalizeJson(hypothesisIds) !== canonicalizeJson(expectedIds)) {
        reasons.add('decision-multiple-comparison-family-mismatch');
      }
      const correctedById = new Map(Array.isArray(hypotheses) ? hypotheses.flatMap((entry) => {
        if (entry === null || Array.isArray(entry) || typeof entry !== 'object') return [];
        const object = entry as Record<string, JsonValue>;
        return typeof object.hypothesisId === 'string' && typeof object.rawPValue === 'number'
          ? [[object.hypothesisId, object.rawPValue] as const]
          : [];
      }) : []);
      for (const member of hypothesisMembers) {
        const source = recordByResultId.get(member.analysisResultId);
        const sourceHypotheses = source?.analysisStatus === 'completed'
          && source.value !== null && !Array.isArray(source.value) && typeof source.value === 'object'
          ? (source.value as Record<string, JsonValue>).hypotheses
          : undefined;
        const sourcePValue = Array.isArray(sourceHypotheses)
          ? sourceHypotheses.flatMap((entry) => {
            if (entry === null || Array.isArray(entry) || typeof entry !== 'object') return [];
            const object = entry as Record<string, JsonValue>;
            return object.hypothesisId === member.hypothesisId && typeof object.pValue === 'number'
              ? [object.pValue]
              : [];
          })
          : [];
        if (sourcePValue.length !== 1
            || correctedById.get(member.hypothesisId) !== sourcePValue[0]) {
          reasons.add('decision-multiple-comparison-lineage-mismatch');
        }
      }
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
  executionSource: ExecutionBundleSource;
  evaluationSource: EvaluationBundleSource;
  analysisSource: AnalysisBundleSource;
  execution: ExecutionBundleSource['bundle'];
  evaluation: EvaluationBundleSource['bundle'];
  analysis: AnalysisBundle;
  policy: NonNullable<SealedRunPlan['decision']['decisionPolicy']>;
  runtime: RuntimeIdentity;
  port: AnalysisDecisionPolicy;
}

function prepareDecision(
  plan: SealedRunPlan,
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  analysisSource: AnalysisBundleSource,
  ports: AnalysisRuntimePorts,
  options: DecisionOptions,
): PreparedDecision | undefined {
  validateDecisionOptions(options);
  const policy = plan.decision.decisionPolicy;
  if (policy === undefined) return undefined;
  validateEventSequencer(ports);
  if (plan.measurementPolicy.eventDelivery.writerMode === 'required'
      && ports.eventWriter === undefined) {
    configurationError(
      'DECISION_EVENT_WRITER_REQUIRED',
      'Required EventWriter mode needs an injected EventWriter.',
    );
  }
  assertAnalysisBundleSourceMatchesPlan(
    plan,
    executionSource,
    evaluationSource,
    analysisSource,
  );
  const execution = executionSource.bundle;
  const evaluation = evaluationSource.bundle;
  const analysis = analysisSource.bundle;
  const runtime = plan.decision.runtimes.find((candidate) => (
    candidate.runtimeKind === 'decision-policy'
    && candidate.referenceId === policy.decisionPolicyId
  ));
  const port = ports.decisionPoliciesByDecisionPolicyId.get(policy.decisionPolicyId);
  if (runtime === undefined || port === undefined
      || canonicalizeJson(runtime.identity) !== canonicalizeJson(port.identity)) {
    configurationError(
      'DECISION_RUNTIME_IDENTITY_MISMATCH',
      'DecisionPolicy implementation differs from the sealed DecisionPlan.',
    );
  }
  return {
    executionSource,
    evaluationSource,
    analysisSource,
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
): Promise<DecisionResultSource> {
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
  try {
  const {
    executionSource,
    evaluationSource,
    analysisSource,
    execution,
    evaluation,
    analysis,
    policy,
    runtime,
    port,
  } = prepared;
  await events.emit('decision.started', 'decision-policy', policy.decisionPolicyId, {
    analysisBundleDigest: analysis.bundleDigest,
    decisionPlanDigest: plan.decision.decisionPlanDigest,
  });
  const evidenceStatus = deriveEvaluationStatus({ execution, evaluation, analysis }).evidenceStatus;
  const reasons = gateReasons(
    plan,
    analysis,
    evidenceStatus,
    executionSource,
    evaluationSource,
    analysisSource,
  );
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
    const comparisonById = new Map(plan.analysis.comparisons.map(
      (comparison) => [comparison.comparisonId, comparison],
    ));
    const signal = options.signal ?? new AbortController().signal;
    try {
      output = parseWireDocument(DecisionPolicyOutputSchema, await port.decide(deepFreeze({
        runId: options.runId,
        policy,
        analysisBundleDigest: analysis.bundleDigest as Sha256Digest,
        analysisCoverage: analysis.coverage,
        results,
        contrasts: (policy.comparisonFamily ?? []).map((member) => {
          const comparison = comparisonById.get(member.comparisonId);
          if (comparison === undefined) throw new TypeError('Decision contrast is missing.');
          return {
            analysisResultId: member.analysisResultId,
            ...('hypothesisId' in member ? { hypothesisId: member.hypothesisId } : {}),
            comparisonId: member.comparisonId,
            controlTargetId: comparison.controlTargetId,
            treatmentTargetId: member.treatmentTargetId,
            metricId: member.metricId,
          };
        }),
        evidenceStatus,
        signal,
      })));
      if (signal.aborted) {
        output = { decisionStatus: 'not-decided', reasonCodes: ['decision-cancelled'] };
      }
    } catch {
      output = signal.aborted
        ? { decisionStatus: 'not-decided', reasonCodes: ['decision-cancelled'] }
        : {
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
  let source = verifyDecisionResult(
    result,
    plan,
    executionSource,
    evaluationSource,
    analysisSource,
    { verifiedPolicyExecutionDigests: new Set([result.decisionDigest as Sha256Digest]) },
  );
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
    source = verifyDecisionResult(
      result,
      plan,
      executionSource,
      evaluationSource,
      analysisSource,
      { verifiedPolicyExecutionDigests: new Set([result.decisionDigest as Sha256Digest]) },
    );
    await events.emitRecovery(
      'decision.failed',
      'decision-policy',
      policy.decisionPolicyId,
      { decisionDigest: result.decisionDigest, errorCode: fatalError.code },
    );
  }
  return source;
  } finally {
    events.close();
  }
}

export function startDecision(
  plan: SealedRunPlan,
  executionValue: ExecutionBundleSource,
  evaluationValue: EvaluationBundleSource,
  analysisValue: AnalysisBundleSource,
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
    return {
      events: stream,
      source: Promise.resolve(undefined),
      result: Promise.resolve(undefined),
    };
  }
  const source = runDecision(plan, prepared, ports, options, stream);
  let result: Promise<DecisionResult | undefined> | undefined;
  return {
    events: stream,
    source,
    get result() {
      result ??= source.then((verified) => verified.result);
      return result;
    },
  };
}

export async function decideAnalysis(
  plan: SealedRunPlan,
  executionValue: ExecutionBundleSource,
  evaluationValue: EvaluationBundleSource,
  analysisValue: AnalysisBundleSource,
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

export async function decideAnalysisSource(
  plan: SealedRunPlan,
  executionValue: ExecutionBundleSource,
  evaluationValue: EvaluationBundleSource,
  analysisValue: AnalysisBundleSource,
  ports: AnalysisRuntimePorts,
  options: DecisionOptions,
): Promise<DecisionResultSource | undefined> {
  return startDecision(
    plan,
    executionValue,
    evaluationValue,
    analysisValue,
    ports,
    options,
  ).source;
}

export function materializeEvaluationReport(
  plan: SealedRunPlan,
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  analysisSource: AnalysisBundleSource,
  decisionSource: DecisionResultSource | undefined,
  ports: Pick<AnalysisRuntimePorts, 'clock'>,
  options: EvaluationReportMaterializationOptions,
): EvaluationReport {
  if (!IdentifierSchema.safeParse(options.reportId).success) {
    configurationError(
      'EVALUATION_REPORT_IDENTIFIER_INVALID',
      'reportId must be a valid Evaluation Core identifier.',
    );
  }
  assertAnalysisBundleSourceMatchesPlan(
    plan,
    executionSource,
    evaluationSource,
    analysisSource,
  );
  const execution = executionSource.bundle;
  const evaluation = evaluationSource.bundle;
  const analysis = analysisSource.bundle;
  const decision = decisionSource?.result;
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
    budgetSummary: evaluation.budgetSummary,
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
        effectiveExecutionBundleTrust(executionSource),
        effectiveEvaluationBundleTrust(evaluationSource),
        effectiveAnalysisBundleTrust(analysisSource),
        ...(decisionSource === undefined
          ? []
          : [effectiveDecisionResultTrust(decisionSource)]),
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
    executionSource,
    evaluationSource,
    analysisSource,
    decisionSource,
  ));
}

export function startReportMaterialization(
  plan: SealedRunPlan,
  executionValue: ExecutionBundleSource,
  evaluationValue: EvaluationBundleSource,
  analysisValue: AnalysisBundleSource,
  decisionValue: DecisionResultSource | undefined,
  ports: AnalysisRuntimePorts,
  options: EvaluationReportRunOptions,
): EvaluationReportRun {
  validateDecisionOptions(options);
  validateEventSequencer(ports);
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
    try {
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
      throw new AnalysisPortFailure(fatalError);
    }
    return report;
    } finally {
      events.close();
    }
  })();
  return { events: stream, result };
}
