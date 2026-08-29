import {
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  AnalysisBundleSchema,
  AnalysisRecordSchema,
  AssumptionCheckSchema,
  IdentifierSchema,
  SchemaIdentitySchema,
  assertEvaluationBundleSource,
  assertExecutionBundleSource,
  canonicalizeJson,
  countAnalysisResamplingUnits,
  derivePlannedEvaluationCoordinates,
  derivePlannedExecutionCoordinates,
  digestArtifactPayload,
  digestCanonicalJson,
  effectiveEvaluationBundleTrust,
  parseWireDocument,
  schemaIdentityKey,
  verifyAnalysisBundle,
  type AnalysisBundle,
  type AnalysisBundleSource,
  type CoreSchemaValidator,
  type AnalysisObservationCoverage,
  type AnalysisRecord,
  type EvaluationBundle,
  type EvaluationBundleSource,
  type EvaluationError,
  type ExecutionBundle,
  type ExecutionBundleSource,
  type JsonValue,
  type Provenance,
  type RuntimeIdentity,
  type SchemaIdentity,
  type Sha256Digest,
} from '../contracts/index.js';
import { deepFreeze, snapshotJson } from '../compiler/immutability.js';
import type { SealedRunPlan } from '../compiler/index.js';
import { BoundedEventStream } from '../runtime/event-stream.js';
import { RuntimeEventEmitter } from '../runtime/events.js';
import {
  AnalysisPortFailure,
  AnalysisNodeExecutionResultSchema,
  AnalysisRuntimeConfigurationError,
  type AnalysisMetricRow,
  type AnalysisMissingPolicy,
  type AnalysisNodeExecutionResult,
  type AnalysisNodeImplementation,
  type AnalysisNodeInput,
  type AnalysisRun,
  type AnalysisRunOptions,
  type AnalysisRuntimeEventKind,
  type AnalysisRuntimePorts,
} from './types.js';

interface NodeBinding {
  node: SealedRunPlan['analysis']['analysisGraph']['nodes'][number];
  port: AnalysisNodeImplementation;
  runtime: RuntimeIdentity;
  outputSchema: SchemaIdentity;
  validator: CoreSchemaValidator;
}

interface PreparedAnalysisRuntime {
  executionSource: ExecutionBundleSource;
  evaluationSource: EvaluationBundleSource;
  execution: ExecutionBundle;
  evaluation: EvaluationBundle;
  nodeBindings: ReadonlyMap<string, NodeBinding>;
  missingPolicies: ReadonlyMap<string, AnalysisMissingPolicy>;
}

interface StopState {
  stopKind?: 'cancelled' | 'failed';
  reasonCode?: string;
  error?: EvaluationError;
}

const TRUST_LEVEL = { untrusted: 0, unknown: 1, declared: 2, verified: 3 } as const;

class AnalysisCancelledError extends Error {
  constructor() {
    super('Analysis run was cancelled.');
    this.name = 'AbortError';
  }
}

function configurationError(code: string, message: string): never {
  throw new AnalysisRuntimeConfigurationError(code, message);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateOptions(options: AnalysisRunOptions): void {
  if (!IdentifierSchema.safeParse(options.runId).success
      || !IdentifierSchema.safeParse(options.bundleId).success) {
    configurationError(
      'ANALYSIS_RUNTIME_IDENTIFIER_INVALID',
      'runId and bundleId must be valid Evaluation Core identifiers.',
    );
  }
  if (options.eventBufferCapacity !== undefined
      && (!Number.isSafeInteger(options.eventBufferCapacity)
        || options.eventBufferCapacity < 1)) {
    configurationError(
      'ANALYSIS_RUNTIME_EVENT_BUFFER_INVALID',
      'eventBufferCapacity must be a positive safe integer.',
    );
  }
}

function prepareRuntime(
  plan: SealedRunPlan,
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  ports: AnalysisRuntimePorts,
  options: AnalysisRunOptions,
): PreparedAnalysisRuntime {
  validateOptions(options);
  assertExecutionBundleSource(executionSource);
  assertEvaluationBundleSource(evaluationSource);
  if (ports.eventSequencer === undefined) {
    configurationError(
      'ANALYSIS_RUNTIME_EVENT_SEQUENCER_REQUIRED',
      'Analysis runtime requires a shared per-Run EventSequencer.',
    );
  }
  if (plan.measurementPolicy.eventDelivery.writerMode === 'required'
      && ports.eventWriter === undefined) {
    configurationError(
      'ANALYSIS_RUNTIME_EVENT_WRITER_REQUIRED',
      'Required EventWriter mode needs an injected EventWriter.',
    );
  }
  const execution = executionSource.bundle;
  const evaluation = evaluationSource.bundle;
  const runtimeByNodeId = new Map(plan.analysis.runtimes
    .filter((runtime) => runtime.runtimeKind === 'analysis-node')
    .map((runtime) => [runtime.referenceId, runtime]));
  const nodeBindings = new Map<string, NodeBinding>();
  for (const node of plan.analysis.analysisGraph.nodes) {
    const runtime = runtimeByNodeId.get(node.nodeId);
    const port = ports.analysisNodes.get(node.implementationId);
    const parsedCapabilities = runtime === undefined
      ? undefined
      : SchemaIdentitySchema.safeParse(
        runtime.identity.capabilities !== null
          && typeof runtime.identity.capabilities === 'object'
          ? (runtime.identity.capabilities as Record<string, unknown>).outputSchema
          : undefined,
      );
    if (runtime === undefined || port === undefined || parsedCapabilities?.success !== true) {
      configurationError(
        'ANALYSIS_RUNTIME_NODE_MISSING',
        `No sealed Analysis implementation is registered for ${node.nodeId}.`,
      );
    }
    const validator = ports.schemaValidators.get(schemaIdentityKey(parsedCapabilities.data));
    if (canonicalizeJson(port.identity) !== canonicalizeJson(runtime.identity)
        || canonicalizeJson(port.outputSchema) !== canonicalizeJson(parsedCapabilities.data)
        || validator === undefined
        || canonicalizeJson(validator.schema) !== canonicalizeJson(parsedCapabilities.data)) {
      configurationError(
        'ANALYSIS_RUNTIME_IDENTITY_MISMATCH',
        `Analysis implementation identity for ${node.nodeId} differs from the sealed plan.`,
      );
    }
    nodeBindings.set(node.nodeId, {
      node,
      port,
      runtime: runtime.identity as RuntimeIdentity,
      outputSchema: parsedCapabilities.data,
      validator,
    });
  }
  const missingRuntimeById = new Map(plan.analysis.runtimes
    .filter((runtime) => runtime.runtimeKind === 'missing-policy')
    .map((runtime) => [runtime.referenceId, runtime]));
  const missingPolicies = new Map<string, AnalysisMissingPolicy>();
  for (const metric of plan.analysis.metrics) {
    const runtime = missingRuntimeById.get(metric.missingPolicyId);
    const port = ports.missingPolicies.get(metric.missingPolicyId);
    if (runtime === undefined || port === undefined
        || canonicalizeJson(port.identity) !== canonicalizeJson(runtime.identity)) {
      configurationError(
        'ANALYSIS_RUNTIME_MISSING_POLICY_MISMATCH',
        `MissingPolicy identity for ${metric.missingPolicyId} differs from the sealed plan.`,
      );
    }
    missingPolicies.set(metric.missingPolicyId, port);
  }
  return {
    executionSource,
    evaluationSource,
    execution,
    evaluation,
    nodeBindings,
    missingPolicies,
  };
}

function coordinateKey(value: {
  targetId: string;
  sampleId: string;
  trialIndex: number;
}): string {
  return canonicalizeJson([value.targetId, value.sampleId, value.trialIndex]);
}

function evaluationKey(value: {
  targetId: string;
  sampleId: string;
  trialIndex: number;
  evaluatorId: string;
}): string {
  return canonicalizeJson([
    value.targetId,
    value.sampleId,
    value.trialIndex,
    value.evaluatorId,
  ]);
}

function materializeRows(
  plan: SealedRunPlan,
  execution: ExecutionBundle,
  evaluation: EvaluationBundle,
): ReadonlyMap<string, readonly AnalysisMetricRow[]> {
  const executionCoordinates = new Map(derivePlannedExecutionCoordinates(plan).map(
    (coordinate) => [coordinateKey(coordinate), coordinate],
  ));
  const executionRecords = new Map(execution.records.map(
    (record) => [coordinateKey(record), record],
  ));
  const evaluationRecords = new Map(evaluation.records.map(
    (record) => [evaluationKey(record), record],
  ));
  const evaluatorById = new Map(plan.evaluation.evaluators.map(
    (evaluator) => [evaluator.evaluatorId, evaluator],
  ));
  const metricById = new Map(plan.analysis.metrics.map((metric) => [metric.metricId, metric]));
  const rowsByMetric = new Map<string, AnalysisMetricRow[]>();

  for (const coordinate of derivePlannedEvaluationCoordinates(plan)) {
    const executionCoordinate = executionCoordinates.get(coordinateKey(coordinate));
    const executionRecord = executionRecords.get(coordinateKey(coordinate));
    const evaluationRecord = evaluationRecords.get(evaluationKey(coordinate));
    const evaluator = evaluatorById.get(coordinate.evaluatorId);
    if (executionCoordinate === undefined || evaluator === undefined) {
      throw new TypeError('Sealed evaluation coordinate is incomplete.');
    }
    for (const metricId of evaluator.metricIds) {
      const metric = metricById.get(metricId);
      if (metric === undefined) throw new TypeError('Evaluator references an unknown Metric.');
      const base = {
        rowId: digestCanonicalJson({
          derivation: 'omk.analysis-metric-row-id/v1',
          evaluationId: coordinate.evaluationId,
          metricId,
        }),
        targetId: coordinate.targetId,
        sampleId: coordinate.sampleId,
        trialIndex: coordinate.trialIndex,
        trialId: coordinate.trialId,
        evaluatorId: coordinate.evaluatorId,
        metricId,
        valueType: metric.valueType,
        samplingUnitIds: executionCoordinate.samplingUnitIds,
        censored: executionRecord?.executionStatus === 'budget-censored',
      } as const;
      let row: AnalysisMetricRow;
      if (evaluationRecord === undefined) {
        row = { ...base, rowStatus: 'not-started', reasonCode: 'evaluation-not-started' };
      } else if (evaluationRecord.evaluationStatus === 'not-evaluated') {
        row = {
          ...base,
          rowStatus: 'source-unavailable',
          reasonCode: evaluationRecord.notEvaluatedReasonCode,
        };
      } else if (evaluationRecord.evaluationStatus === 'failed'
          || evaluationRecord.evaluationStatus === 'cancelled') {
        row = {
          ...base,
          rowStatus: 'evaluation-failed',
          reasonCode: evaluationRecord.evaluationStatus === 'failed'
            ? evaluationRecord.error.code
            : evaluationRecord.error?.code ?? 'evaluation-cancelled',
        };
      } else {
        const observation = evaluationRecord.observations.find(
          (candidate) => candidate.metricId === metricId,
        );
        if (observation === undefined) {
          throw new TypeError('Completed EvaluationRecord omits a declared MetricObservation.');
        }
        if (observation.observationStatus === 'observed') {
          row = { ...base, rowStatus: 'observed', value: snapshotJson(observation.value) };
        } else {
          row = {
            ...base,
            rowStatus: observation.observationStatus,
            reasonCode: observation.reasonCode,
          };
        }
      }
      const rows = rowsByMetric.get(metricId) ?? [];
      rows.push(deepFreeze(row));
      rowsByMetric.set(metricId, rows);
    }
  }
  return new Map([...rowsByMetric.entries()].map(([metricId, rows]) => [
    metricId,
    deepFreeze(rows),
  ]));
}

function topologicalNodeIds(plan: SealedRunPlan): string[] {
  const producerByResultId = new Map<string, string>();
  for (const node of plan.analysis.analysisGraph.nodes) {
    producerByResultId.set(node.outputResultId, node.nodeId);
  }
  const dependencies = new Map<string, Set<string>>();
  for (const node of plan.analysis.analysisGraph.nodes) {
    const dependencyIds = new Set(node.inputs.flatMap((input) => {
      if (input.inputKind !== 'analysis-result') return [];
      const producer = producerByResultId.get(input.referenceId);
      if (producer === undefined) throw new TypeError('AnalysisGraph has a missing dependency.');
      return [producer];
    }));
    dependencies.set(node.nodeId, dependencyIds);
  }
  const ready = plan.analysis.analysisGraph.nodes
    .filter((node) => (dependencies.get(node.nodeId)?.size ?? 0) === 0)
    .map((node) => node.nodeId)
    .sort(compareStrings);
  const ordered: string[] = [];
  const remaining = new Set(plan.analysis.analysisGraph.nodes.map((node) => node.nodeId));
  while (ready.length > 0) {
    const nodeId = ready.shift();
    if (nodeId === undefined || !remaining.delete(nodeId)) continue;
    for (const [candidate, candidateDependencies] of dependencies) {
      candidateDependencies.delete(nodeId);
      if (remaining.has(candidate) && candidateDependencies.size === 0) {
        ready.push(candidate);
        ready.sort(compareStrings);
      }
    }
    ordered.push(nodeId);
  }
  if (ordered.length !== plan.analysis.analysisGraph.nodes.length) {
    throw new TypeError('AnalysisGraph is cyclic.');
  }
  return ordered;
}

function orderedBindings(
  plan: SealedRunPlan,
  bindings: ReadonlyMap<string, NodeBinding>,
): NodeBinding[] {
  return topologicalNodeIds(plan).map((nodeId) => {
    const binding = bindings.get(nodeId);
    if (binding === undefined) throw new TypeError('Analysis node binding is missing.');
    return binding;
  });
}

function rowsForInputs(inputs: readonly AnalysisNodeInput[]): AnalysisMetricRow[] {
  const byId = new Map<string, AnalysisMetricRow>();
  for (const input of inputs) {
    if (input.inputKind !== 'metric-observations') continue;
    for (const row of input.rows) byId.set(row.rowId, row);
  }
  return [...byId.values()].sort((left, right) => compareStrings(left.rowId, right.rowId));
}

function observationCoverage(
  rows: readonly AnalysisMetricRow[],
  includedRowIds: readonly Sha256Digest[],
  comparableRowIds: readonly Sha256Digest[],
): AnalysisObservationCoverage {
  const included = new Set(includedRowIds);
  const comparable = new Set(comparableRowIds);
  const known = new Set(rows.map((row) => row.rowId));
  if (included.size !== includedRowIds.length
      || comparable.size !== comparableRowIds.length
      || [...included].some((rowId) => !known.has(rowId))
      || [...comparable].some((rowId) => !included.has(rowId))) {
    throw new TypeError('Analysis implementation returned invalid row membership.');
  }
  const coverage: AnalysisObservationCoverage = {
    planned: rows.length,
    observed: 0,
    missing: 0,
    invalid: 0,
    evaluationFailed: 0,
    sourceUnavailable: 0,
    notStarted: 0,
    censored: 0,
    included: included.size,
    excluded: rows.length - included.size,
    comparable: comparable.size,
  };
  for (const row of rows) {
    if (row.rowStatus === 'observed') coverage.observed += 1;
    else if (row.rowStatus === 'missing') coverage.missing += 1;
    else if (row.rowStatus === 'invalid') coverage.invalid += 1;
    else if (row.rowStatus === 'evaluation-failed') coverage.evaluationFailed += 1;
    else if (row.rowStatus === 'source-unavailable') coverage.sourceUnavailable += 1;
    else coverage.notStarted += 1;
    if (row.censored) coverage.censored += 1;
  }
  if ([...included].some((rowId) => (
    rows.find((row) => row.rowId === rowId)?.rowStatus !== 'observed'
  ))) {
    throw new TypeError('v1 Analysis cannot include a non-observed row.');
  }
  return coverage;
}

function emptyCoverage(rows: readonly AnalysisMetricRow[]): AnalysisObservationCoverage {
  return observationCoverage(rows, [], []);
}

function exclusionFacts(
  rows: readonly AnalysisMetricRow[],
  includedRowIds: readonly Sha256Digest[],
): Array<{ rowId: Sha256Digest; reasonCode: string }> {
  const included = new Set(includedRowIds);
  return rows
    .filter((row) => !included.has(row.rowId))
    .map((row) => ({
      rowId: row.rowId,
      reasonCode: row.rowStatus === 'observed'
        ? row.censored ? 'analysis-row-censored' : 'analysis-estimator-excluded'
        : row.reasonCode,
    }))
    .sort((left, right) => compareStrings(left.rowId, right.rowId));
}

function safeError(error: unknown): EvaluationError {
  if (error instanceof AnalysisPortFailure) return error.evaluationError;
  if (error instanceof AnalysisCancelledError) {
    return { code: 'analysis-cancelled', stage: 'analysis', message: 'Analysis cancelled.' };
  }
  return {
    code: 'analysis-runtime-failed',
    stage: 'analysis',
    message: 'Analysis implementation failed.',
  };
}

function recordDigest(record: Omit<AnalysisRecord, 'recordDigest'>): Sha256Digest {
  return digestCanonicalJson(record);
}

function buildRecord(
  base: Readonly<Record<string, unknown>>,
  terminal: Readonly<Record<string, unknown>>,
): AnalysisRecord {
  const payload = snapshotJson({ ...base, ...terminal }) as Omit<
    AnalysisRecord,
    'recordDigest'
  >;
  return parseWireDocument(AnalysisRecordSchema, {
    ...payload,
    recordDigest: recordDigest(payload),
  });
}

function parentDigests(
  node: NodeBinding['node'],
  evaluationBundle: EvaluationBundle,
  analysisPlanDigest: Sha256Digest,
  recordsByResultId: ReadonlyMap<string, AnalysisRecord>,
): Sha256Digest[] {
  const parents = new Set<Sha256Digest>();
  for (const input of node.inputs) {
    if (input.inputKind === 'metric-observations') {
      parents.add(evaluationBundle.bundleDigest as Sha256Digest);
    } else if (input.inputKind === 'comparison') {
      parents.add(analysisPlanDigest);
    } else {
      const record = recordsByResultId.get(input.referenceId);
      if (record === undefined) throw new TypeError('Analysis parent record is missing.');
      parents.add(record.recordDigest as Sha256Digest);
    }
  }
  return [...parents].sort(compareStrings);
}

function materializeNodeInputs(
  plan: SealedRunPlan,
  binding: NodeBinding,
  rowsByMetric: ReadonlyMap<string, readonly AnalysisMetricRow[]>,
  recordsByResultId: ReadonlyMap<string, AnalysisRecord>,
): { inputs: AnalysisNodeInput[]; blockedReasonCodes: string[] } {
  const inputs: AnalysisNodeInput[] = [];
  const blockedReasonCodes: string[] = [];
  for (const input of binding.node.inputs) {
    if (input.inputKind === 'metric-observations') {
      const metric = plan.analysis.metrics.find((candidate) => (
        candidate.metricId === input.referenceId
      ));
      if (metric === undefined) throw new TypeError('Analysis metric input is missing.');
      inputs.push({
        inputKind: 'metric-observations',
        referenceId: input.referenceId,
        metric,
        rows: rowsByMetric.get(input.referenceId) ?? [],
      });
    } else if (input.inputKind === 'comparison') {
      const comparison = plan.analysis.comparisons.find((candidate) => (
        candidate.comparisonId === input.referenceId
      ));
      if (comparison === undefined) throw new TypeError('Analysis comparison input is missing.');
      if (!comparison.treatmentTargetIds.includes(input.treatmentTargetId)
          || !comparison.metricIds.includes(input.metricId)) {
        throw new TypeError('Analysis comparison contrast is missing.');
      }
      inputs.push({
        inputKind: 'comparison',
        referenceId: input.referenceId,
        contrast: {
          comparisonId: comparison.comparisonId,
          controlTargetId: comparison.controlTargetId,
          treatmentTargetId: input.treatmentTargetId,
          metricId: input.metricId,
        },
      });
    } else {
      const record = recordsByResultId.get(input.referenceId);
      if (record?.analysisStatus !== 'completed') {
        blockedReasonCodes.push('analysis-parent-not-completed');
      } else {
        inputs.push({
          inputKind: 'analysis-result',
          referenceId: input.referenceId,
          record,
        });
      }
    }
  }
  const comparisons = inputs.filter(
    (input): input is Extract<AnalysisNodeInput, { inputKind: 'comparison' }> => (
      input.inputKind === 'comparison'
    ),
  );
  if (comparisons.length > 0) {
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      if (input.inputKind !== 'metric-observations') continue;
      const matchingContrasts = comparisons.filter(
        (comparison) => comparison.contrast.metricId === input.referenceId,
      );
      const allowedTargets = new Set(matchingContrasts.flatMap((comparison) => [
        comparison.contrast.controlTargetId,
        comparison.contrast.treatmentTargetId,
      ]));
      inputs[index] = {
        ...input,
        rows: matchingContrasts.length > 0
          ? input.rows.filter((row) => allowedTargets.has(row.targetId))
          : [],
      };
    }
  }
  return { inputs, blockedReasonCodes: [...new Set(blockedReasonCodes)].sort(compareStrings) };
}

function validateMissingPolicies(
  policies: ReadonlyMap<string, AnalysisMissingPolicy>,
  inputs: readonly AnalysisNodeInput[],
): string[] {
  const rejectionCodes = new Set<string>();
  for (const input of inputs) {
    if (input.inputKind !== 'metric-observations') continue;
    const policy = policies.get(input.metric.missingPolicyId);
    if (policy === undefined) throw new TypeError('MissingPolicy port disappeared after prepare.');
    for (const row of input.rows) {
      if (row.rowStatus === 'observed') continue;
      const disposition = policy.decide(deepFreeze({ metric: input.metric, row }));
      if (disposition === 'reject') {
        rejectionCodes.add(`missing-policy-rejected:${input.metric.metricId}`);
      }
    }
  }
  return [...rejectionCodes].sort(compareStrings);
}

function terminalEventKind(
  status: AnalysisBundle['analysisBundleStatus'],
): 'analysis.run.completed' | 'analysis.run.cancelled' | 'analysis.run.failed' {
  if (status === 'completed') return 'analysis.run.completed';
  if (status === 'cancelled') return 'analysis.run.cancelled';
  return 'analysis.run.failed';
}

function deriveTrust(
  plan: SealedRunPlan,
  source: Provenance['trust'],
): Provenance['trust'] {
  const executedNodeIds = new Set(plan.analysis.analysisGraph.nodes.map((node) => node.nodeId));
  const usedMissingPolicyIds = new Set(plan.analysis.metrics.map(
    (metric) => metric.missingPolicyId,
  ));
  const trusts = plan.analysis.runtimes.flatMap((runtime) => (
    (runtime.runtimeKind === 'analysis-node' && executedNodeIds.has(runtime.referenceId))
      || (runtime.runtimeKind === 'missing-policy' && usedMissingPolicyIds.has(runtime.referenceId))
      ? [runtime.identity.assuranceLevel]
      : []
  ));
  return [source, ...trusts].sort(
    (left, right) => TRUST_LEVEL[left] - TRUST_LEVEL[right],
  )[0];
}

function makeBundle(
  plan: SealedRunPlan,
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  options: AnalysisRunOptions,
  records: readonly AnalysisRecord[],
  schemaValidators: ReadonlyMap<string, CoreSchemaValidator>,
  stop: StopState,
): AnalysisBundleSource {
  const evaluation = evaluationSource.bundle;
  const ordered = [...records].sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  const coverage = {
    planned: ordered.length,
    started: ordered.filter((record) => record.analysisStatus !== 'not-evaluated').length,
    completed: ordered.filter((record) => record.analysisStatus === 'completed').length,
    inconclusive: ordered.filter((record) => record.analysisStatus === 'inconclusive').length,
    failed: ordered.filter((record) => record.analysisStatus === 'failed').length,
    notStarted: ordered.filter((record) => record.analysisStatus === 'not-evaluated').length,
  };
  const payload = {
    schemaVersion: ANALYSIS_BUNDLE_SCHEMA_VERSION,
    bundleId: options.bundleId,
    runContractDigest: plan.digests.runContractDigest,
    evaluationBundleDigest: evaluation.bundleDigest,
    analysisPlanDigest: plan.analysis.analysisPlanDigest,
    analysisBundleStatus: stop.stopKind ?? 'completed',
    ...(stop.stopKind !== undefined ? { terminationReasonCode: stop.reasonCode } : {}),
    coverage,
    records: ordered,
    provenance: {
      provenanceKind: 'derived' as const,
      trust: deriveTrust(plan, effectiveEvaluationBundleTrust(evaluationSource)),
      parentDigests: [evaluation.bundleDigest],
      ...(stop.error !== undefined ? { facets: { terminalErrorCode: stop.error.code } } : {}),
    },
  };
  const bundle = parseWireDocument(AnalysisBundleSchema, {
    ...payload,
    bundleDigest: digestArtifactPayload(
      { ...payload, bundleDigest: digestCanonicalJson(null) },
      'bundleDigest',
    ),
  });
  return verifyAnalysisBundle(
    bundle,
    plan,
    executionSource,
    evaluationSource,
    { schemaValidators },
    {
      verifiedProvenanceBundleDigests: new Set([
        bundle.bundleDigest as Sha256Digest,
      ]),
    },
  );
}

async function runAnalysis(
  plan: SealedRunPlan,
  ports: AnalysisRuntimePorts,
  options: AnalysisRunOptions,
  prepared: PreparedAnalysisRuntime,
  stream: BoundedEventStream,
): Promise<AnalysisBundleSource> {
  const stop: StopState = {};
  const setStop = (
    stopKind: NonNullable<StopState['stopKind']>,
    reasonCode: string,
    error?: EvaluationError,
  ): void => {
    if (stop.stopKind === 'failed') return;
    if (stopKind === 'failed' || stop.stopKind === undefined) {
      stop.stopKind = stopKind;
      stop.reasonCode = reasonCode;
      stop.error = error;
    }
  };
  const events = new RuntimeEventEmitter<
    AnalysisRuntimeEventKind,
    'run' | 'analysis-node',
    'analysis.run.completed' | 'analysis.run.cancelled' | 'analysis.run.failed'
  >(
    ports.clock,
    ports.eventSequencer,
    ports.eventWriter,
    {
      runId: options.runId,
      writerMode: plan.measurementPolicy.eventDelivery.writerMode,
      writerFailureMode: plan.measurementPolicy.eventDelivery.writerFailureMode,
      writerFailureReason: 'analysis-event-writer-failed',
      writerFailureError: {
        code: 'analysis-event-writer-failed',
        stage: 'infrastructure',
        message: 'Analysis EventWriter failed.',
      },
      recoveryEventKinds: [
        'analysis.run.completed',
        'analysis.run.cancelled',
        'analysis.run.failed',
      ],
    },
    stream,
    (reasonCode, error) => setStop('failed', reasonCode, error),
  );
  const controller = new AbortController();
  const externalAbort = (): void => {
    setStop('cancelled', 'analysis-external-cancelled');
    controller.abort();
  };
  if (options.signal?.aborted === true) externalAbort();
  else options.signal?.addEventListener('abort', externalAbort, { once: true });

  try {
  const rowsByMetric = materializeRows(plan, prepared.execution, prepared.evaluation);
  const records: AnalysisRecord[] = [];
  const recordsByResultId = new Map<string, AnalysisRecord>();
  const bindings = orderedBindings(plan, prepared.nodeBindings);
  await events.emit('analysis.run.started', 'run', options.runId, {
    analysisPlanDigest: plan.analysis.analysisPlanDigest,
    evaluationBundleDigest: prepared.evaluation.bundleDigest,
  });

  for (const binding of bindings) {
    const { inputs, blockedReasonCodes } = materializeNodeInputs(
      plan,
      binding,
      rowsByMetric,
      recordsByResultId,
    );
    const rows = rowsForInputs(inputs);
    const base = {
      resultId: binding.node.outputResultId,
      nodeId: binding.node.nodeId,
      analysisNodeKind: binding.node.analysisNodeKind,
      implementation: binding.runtime,
      outputSchema: binding.outputSchema,
      inputReferences: binding.node.inputs,
      coverage: emptyCoverage(rows),
      exclusions: exclusionFacts(rows, []),
      assumptionChecks: [],
      analysisMode: plan.analysis.analysisGraph.analysisMode,
      derivedAt: ports.clock.timestamp(),
      parentDigests: parentDigests(
        binding.node,
        prepared.evaluation,
        plan.analysis.analysisPlanDigest as Sha256Digest,
        recordsByResultId,
      ),
    } as const;
    if (stop.stopKind !== undefined || blockedReasonCodes.length > 0) {
      const reasonCodes = stop.stopKind === 'cancelled'
        ? ['analysis-run-cancelled']
        : stop.stopKind === 'failed'
          ? ['analysis-run-failed']
          : blockedReasonCodes;
      const record = buildRecord(base, {
        analysisStatus: 'not-evaluated',
        reasonCodes,
      } as never);
      records.push(record);
      recordsByResultId.set(record.resultId, record);
      await events.emit('analysis.node.not-evaluated', 'analysis-node', binding.node.nodeId, {
        reasonCodes,
      });
      continue;
    }
    let missingRejections: string[];
    try {
      missingRejections = validateMissingPolicies(prepared.missingPolicies, inputs);
    } catch (error) {
      const evaluationError = safeError(error);
      const record = buildRecord(base, {
        analysisStatus: 'failed',
        error: evaluationError,
      });
      records.push(record);
      recordsByResultId.set(record.resultId, record);
      setStop('failed', evaluationError.code, evaluationError);
      await events.emit('analysis.node.failed', 'analysis-node', binding.node.nodeId, {
        reasonCode: evaluationError.code,
      });
      continue;
    }
    if (missingRejections.length > 0) {
      const checks = missingRejections.map((reasonCode, index) => parseWireDocument(
        AssumptionCheckSchema,
        {
          assumptionId: `missing-policy-${index + 1}`,
          nodeId: binding.node.nodeId,
          checkStatus: 'failed',
          reasonCode,
        },
      ));
      const record = buildRecord({ ...base, assumptionChecks: checks }, {
        analysisStatus: 'inconclusive',
        reasonCodes: missingRejections,
      } as never);
      records.push(record);
      recordsByResultId.set(record.resultId, record);
      await events.emit('analysis.node.inconclusive', 'analysis-node', binding.node.nodeId, {
        reasonCodes: missingRejections,
      });
      continue;
    }
    if (controller.signal.aborted) {
      setStop('cancelled', 'analysis-external-cancelled');
      continue;
    }
    await events.emit('analysis.node.started', 'analysis-node', binding.node.nodeId, {});
    let run;
    let output: AnalysisNodeExecutionResult | undefined;
    let failure: EvaluationError | undefined;
    let disposalFailed = false;
    try {
      run = await binding.port.openRun(deepFreeze({
        runId: options.runId,
        analysisPlanDigest: plan.analysis.analysisPlanDigest as Sha256Digest,
        evaluationBundleDigest: prepared.evaluation.bundleDigest as Sha256Digest,
        analysisMode: plan.analysis.analysisGraph.analysisMode,
      }));
      if (controller.signal.aborted) throw new AnalysisCancelledError();
      const rawOutput = await run.execute(deepFreeze({
        node: binding.node,
        inputs,
        analysisPlanDigest: plan.analysis.analysisPlanDigest as Sha256Digest,
        sampling: plan.analysis.experiment.sampling,
        rootSeed: plan.analysis.experiment.seed,
        signal: controller.signal,
      }));
      output = parseWireDocument(
        AnalysisNodeExecutionResultSchema,
        rawOutput,
      ) as AnalysisNodeExecutionResult;
      if (controller.signal.aborted) throw new AnalysisCancelledError();
    } catch (error) {
      failure = safeError(error);
    } finally {
      if (run !== undefined) {
        try {
          await run.dispose();
        } catch {
          disposalFailed = true;
          failure = {
            code: 'analysis-node-dispose-failed',
            stage: 'infrastructure',
            message: 'Analysis node resource disposal failed.',
          };
        }
      }
    }
    if (controller.signal.aborted && !disposalFailed) {
      failure = safeError(new AnalysisCancelledError());
      output = undefined;
    }
    if (failure !== undefined || output === undefined) {
      if (failure?.code === 'analysis-cancelled') {
        setStop('cancelled', 'analysis-external-cancelled');
        const record = buildRecord(base, {
          analysisStatus: 'not-evaluated',
          reasonCodes: ['analysis-run-cancelled'],
        } as never);
        records.push(record);
        recordsByResultId.set(record.resultId, record);
        continue;
      }
      const error = failure ?? {
        code: 'analysis-node-empty-result',
        stage: 'analysis' as const,
        message: 'Analysis node returned no result.',
      };
      const record = buildRecord(base, { analysisStatus: 'failed', error } as never);
      records.push(record);
      recordsByResultId.set(record.resultId, record);
      setStop('failed', error.code, error);
      await events.emit('analysis.node.failed', 'analysis-node', binding.node.nodeId, {
        reasonCode: error.code,
      });
      continue;
    }
    const observedRowIds = rows
      .filter((row) => row.rowStatus === 'observed')
      .map((row) => row.rowId);
    const includedRowIds = output.includedRowIds ?? observedRowIds;
    const comparableRowIds = output.comparableRowIds ?? includedRowIds;
    let coverage: AnalysisObservationCoverage;
    try {
      coverage = observationCoverage(rows, includedRowIds, comparableRowIds);
    } catch (error) {
      const evaluationError = safeError(error);
      const record = buildRecord(base, {
        analysisStatus: 'failed',
        error: evaluationError,
      } as never);
      records.push(record);
      recordsByResultId.set(record.resultId, record);
      setStop('failed', evaluationError.code, evaluationError);
      await events.emit('analysis.node.failed', 'analysis-node', binding.node.nodeId, {
        reasonCode: evaluationError.code,
      });
      continue;
    }
    let checks;
    try {
      checks = (output.assumptionChecks ?? []).map((check) => {
        if ((check.checkStatus === 'passed') === (check.reasonCode !== undefined)) {
          throw new TypeError('Analysis assumption result is inconsistent.');
        }
        return parseWireDocument(
          AssumptionCheckSchema,
          { ...check, nodeId: binding.node.nodeId },
        );
      });
    } catch (error) {
      const evaluationError = safeError(error);
      const record = buildRecord(base, {
        analysisStatus: 'failed',
        error: evaluationError,
      });
      records.push(record);
      recordsByResultId.set(record.resultId, record);
      setStop('failed', evaluationError.code, evaluationError);
      await events.emit('analysis.node.failed', 'analysis-node', binding.node.nodeId, {
        reasonCode: evaluationError.code,
      });
      continue;
    }
    if (output.analysisStatus === 'completed') {
      const failedChecks = checks.filter((check) => check.checkStatus !== 'passed');
      if (failedChecks.length > 0) {
        const reasonCodes = failedChecks.map((check) => check.reasonCode as string).sort();
        const record = buildRecord({
          ...base,
          coverage,
          exclusions: exclusionFacts(rows, includedRowIds),
          assumptionChecks: checks,
        }, {
          analysisStatus: 'inconclusive',
          reasonCodes,
        });
        records.push(record);
        recordsByResultId.set(record.resultId, record);
        await events.emit('analysis.node.inconclusive', 'analysis-node', binding.node.nodeId, {
          reasonCodes,
          coverage,
        });
        continue;
      }
      let value: JsonValue;
      try {
        value = snapshotJson(output.value);
        const envelope = { resultType: output.resultType, value } as const;
        const includedRowIdSet = new Set(includedRowIds);
        if (canonicalizeJson(binding.validator.parse(envelope, {
          validationKind: 'analysis-output',
          parameters: binding.node.parameters ?? {},
          inputFacts: {
            resamplingUnitCount: countAnalysisResamplingUnits(
              plan.analysis.experiment.sampling.resamplingUnit,
              rows.filter((row) => includedRowIdSet.has(row.rowId)),
              inputs.flatMap((input) => input.inputKind === 'comparison'
                ? [input.contrast.controlTargetId, input.contrast.treatmentTargetId]
                : []),
            ),
          },
        })) !== canonicalizeJson(envelope)) {
          throw new TypeError('Analysis output does not match the sealed schema.');
        }
      } catch (error) {
        const evaluationError = safeError(error);
        const record = buildRecord(base, {
          analysisStatus: 'failed',
          error: evaluationError,
        } as never);
        records.push(record);
        recordsByResultId.set(record.resultId, record);
        setStop('failed', evaluationError.code, evaluationError);
        await events.emit('analysis.node.failed', 'analysis-node', binding.node.nodeId, {
          reasonCode: evaluationError.code,
        });
        continue;
      }
      const record = buildRecord({
        ...base,
        coverage,
        exclusions: exclusionFacts(rows, includedRowIds),
        assumptionChecks: checks,
      }, {
        analysisStatus: 'completed',
        resultType: output.resultType,
        value,
      } as never);
      records.push(record);
      recordsByResultId.set(record.resultId, record);
      await events.emit('analysis.node.completed', 'analysis-node', binding.node.nodeId, {
        resultId: record.resultId,
        recordDigest: record.recordDigest,
        coverage,
      });
    } else {
      const reasonCodes = [...new Set(output.reasonCodes)].sort(compareStrings);
      const record = buildRecord({
        ...base,
        coverage,
        exclusions: exclusionFacts(rows, includedRowIds),
        assumptionChecks: checks,
      }, {
        analysisStatus: 'inconclusive',
        reasonCodes,
      } as never);
      records.push(record);
      recordsByResultId.set(record.resultId, record);
      await events.emit('analysis.node.inconclusive', 'analysis-node', binding.node.nodeId, {
        reasonCodes,
        coverage,
      });
    }
  }

  let source = makeBundle(
    plan,
    prepared.executionSource,
    prepared.evaluationSource,
    options,
    records,
    ports.schemaValidators,
    stop,
  );
  const delivered = await events.emit(
    terminalEventKind(source.bundle.analysisBundleStatus),
    'run',
    options.runId,
    {
      bundleDigest: source.bundle.bundleDigest,
      analysisBundleStatus: source.bundle.analysisBundleStatus,
      coverage: source.bundle.coverage,
    },
  );
  if (!delivered) {
    source = makeBundle(
      plan,
      prepared.executionSource,
      prepared.evaluationSource,
      options,
      records,
      ports.schemaValidators,
      stop,
    );
    await events.emitRecovery(
      terminalEventKind(source.bundle.analysisBundleStatus),
      'run',
      options.runId,
      {
        bundleDigest: source.bundle.bundleDigest,
        analysisBundleStatus: source.bundle.analysisBundleStatus,
        coverage: source.bundle.coverage,
      },
    );
  }
  return source;
  } finally {
    options.signal?.removeEventListener('abort', externalAbort);
    events.close();
  }
}

export function startAnalysis(
  plan: SealedRunPlan,
  executionBundle: ExecutionBundleSource,
  evaluationBundle: EvaluationBundleSource,
  ports: AnalysisRuntimePorts,
  options: AnalysisRunOptions,
): AnalysisRun {
  const prepared = prepareRuntime(
    plan,
    executionBundle,
    evaluationBundle,
    ports,
    options,
  );
  const stream = new BoundedEventStream(options.eventBufferCapacity ?? 256);
  const source = runAnalysis(plan, ports, options, prepared, stream);
  let result: Promise<AnalysisBundle> | undefined;
  return {
    events: stream,
    source,
    get result() {
      result ??= source.then((verified) => verified.bundle);
      return result;
    },
  };
}

export async function analyzeEvaluationBundle(
  plan: SealedRunPlan,
  executionBundle: ExecutionBundleSource,
  evaluationBundle: EvaluationBundleSource,
  ports: AnalysisRuntimePorts,
  options: AnalysisRunOptions,
): Promise<AnalysisBundle> {
  return startAnalysis(plan, executionBundle, evaluationBundle, ports, options).result;
}

export async function analyzeEvaluationBundleSource(
  plan: SealedRunPlan,
  executionBundle: ExecutionBundleSource,
  evaluationBundle: EvaluationBundleSource,
  ports: AnalysisRuntimePorts,
  options: AnalysisRunOptions,
): Promise<AnalysisBundleSource> {
  return startAnalysis(plan, executionBundle, evaluationBundle, ports, options).source;
}
