import { z } from 'zod';
import {
  AssumptionCheckSchema,
  EVALUATION_SERIES_REPORT_SCHEMA_VERSION,
  SERIES_ANALYSIS_BUNDLE_SCHEMA_VERSION,
  SeriesAnalysisRecordSchema,
  SeriesDecisionResultSchema,
  IdentifierSchema,
  JsonValueSchema,
  RuntimeIdentitySchema,
  SchemaIdentitySchema,
  assertEvaluationSeriesMemberSource,
  canonicalizeJson,
  createComparabilityPolicy,
  assessComparability,
  deepFreezeCanonicalJson,
  deriveSeriesMemberCoverage,
  digestCanonicalJson,
  digestSeriesArtifact,
  parseEvaluationSeriesPlan,
  parseEvaluationSeriesReportDocument,
  parseSeriesAnalysisBundleDocument,
  parseWireDocument,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type EvaluationError,
  type EvaluationEvent,
  type EvaluationSeriesMemberSource,
  type EvaluationSeriesPlan,
  type EvaluationSeriesReport,
  type JsonValue,
  type RuntimeIdentity,
  type SchemaIdentity,
  type SeriesAnalysisBundle,
  type SeriesAnalysisRecord,
  type SeriesComparabilityAssessment,
  type SeriesDecisionResult,
  type Sha256Digest,
} from '../contracts/index.js';
import { BoundedEventStream } from '../runtime/event-stream.js';
import {
  InMemoryRuntimeEventSequencer,
  RuntimeEventEmitter,
} from '../runtime/events.js';
import { snapshotSchemaValidators } from '../runtime/snapshot.js';

const DEFAULT_EVENT_BUFFER_CAPACITY = 256;

type SeriesEventKind =
  | 'series.run.started'
  | 'series.analysis-node.started'
  | 'series.analysis-node.completed'
  | 'series.analysis-node.inconclusive'
  | 'series.analysis-node.failed'
  | 'series.decision.started'
  | 'series.decision.completed'
  | 'series.decision.not-decided'
  | 'series.decision.failed'
  | 'series.run.completed'
  | 'series.run.cancelled'
  | 'series.run.failed';

type SeriesEventSubjectKind =
  | 'evaluation-series-run'
  | 'series-analysis-node'
  | 'series-decision-policy';

type SeriesEventEmitter = RuntimeEventEmitter<
  SeriesEventKind,
  SeriesEventSubjectKind,
  never
>;

async function emitSeriesEvent(
  emitter: SeriesEventEmitter,
  eventKind: SeriesEventKind,
  subjectKind: SeriesEventSubjectKind,
  subjectId: string,
  data: JsonValue,
): Promise<void> {
  try {
    await emitter.emit(eventKind, subjectKind, subjectId, data);
  } catch {
    // Event notification is observational; artifacts and result remain authoritative.
  }
}

export interface SeriesAnalysisNodeRunContext {
  readonly runId: string;
  readonly seriesPlanDigest: Sha256Digest;
  readonly bundleId: string;
  readonly nodeId: string;
  readonly analysisMode: EvaluationSeriesPlan['definition']['analysisMode'];
}

export interface SeriesAnalysisNodeContext {
  readonly plan: EvaluationSeriesPlan;
  readonly node: EvaluationSeriesPlan['definition']['analysisGraph']['nodes'][number];
  readonly members: readonly EvaluationSeriesMemberSource[];
  readonly coverage: SeriesAnalysisBundle['coverage'];
  readonly inputs: readonly SeriesAnalysisNodeInput[];
  readonly signal: AbortSignal;
}

export type SeriesAnalysisNodeInput = {
  readonly seriesInputKind: 'members';
  readonly referenceId: string;
  readonly members: readonly EvaluationSeriesMemberSource[];
} | {
  readonly seriesInputKind: 'analysis-result';
  readonly referenceId: string;
  readonly record: Extract<SeriesAnalysisRecord, { analysisStatus: 'completed' }>;
};

const SeriesPortAssumptionCheckSchema = AssumptionCheckSchema.omit({ nodeId: true });

const SeriesAnalysisNodeOutputSchema = z.discriminatedUnion('analysisStatus', [
  z.object({
    analysisStatus: z.literal('completed'),
    resultType: z.enum(['scalar', 'interval', 'distribution', 'table', 'matrix', 'curve']),
    value: JsonValueSchema,
    assumptionChecks: z.array(SeriesPortAssumptionCheckSchema).optional(),
  }).strict(),
  z.object({
    analysisStatus: z.literal('inconclusive'),
    reasonCodes: z.array(IdentifierSchema).min(1),
    assumptionChecks: z.array(SeriesPortAssumptionCheckSchema).optional(),
  }).strict(),
]);

export type SeriesAnalysisNodeOutput = z.infer<typeof SeriesAnalysisNodeOutputSchema>;

export interface SeriesAnalysisNodeRun {
  analyze(context: Readonly<SeriesAnalysisNodeContext>): Promise<SeriesAnalysisNodeOutput>;
  dispose(): void | Promise<void>;
}

export interface SeriesAnalysisNodeRuntime {
  readonly identity: RuntimeIdentity;
  readonly outputSchema: SchemaIdentity;
  openRun(context: Readonly<SeriesAnalysisNodeRunContext>): Promise<SeriesAnalysisNodeRun>;
}

export interface SeriesDecisionRunContext {
  readonly runId: string;
  readonly seriesPlanDigest: Sha256Digest;
  readonly analysisBundleDigest: Sha256Digest;
  readonly decisionPolicyId: string;
}

export interface SeriesDecisionContext {
  readonly plan: EvaluationSeriesPlan;
  readonly bundle: SeriesAnalysisBundle;
  readonly records: readonly Extract<SeriesAnalysisRecord, { analysisStatus: 'completed' }>[];
  readonly signal: AbortSignal;
}

export type SeriesDecisionOutput = {
  decisionStatus: 'decided';
  verdict: string;
  reasonCodes: readonly string[];
} | {
  decisionStatus: 'not-decided';
  reasonCodes: readonly string[];
};

const SeriesDecisionOutputSchema = z.discriminatedUnion('decisionStatus', [
  z.object({
    decisionStatus: z.literal('decided'),
    verdict: z.string().min(1).max(256),
    reasonCodes: z.array(z.string().min(1).max(256)).min(1),
  }).strict(),
  z.object({
    decisionStatus: z.literal('not-decided'),
    reasonCodes: z.array(z.string().min(1).max(256)).min(1),
  }).strict(),
]);

export interface SeriesDecisionRun {
  decide(context: Readonly<SeriesDecisionContext>): Promise<SeriesDecisionOutput>;
  dispose(): void | Promise<void>;
}

export interface SeriesDecisionRuntime {
  readonly identity: RuntimeIdentity;
  openRun(context: Readonly<SeriesDecisionRunContext>): Promise<SeriesDecisionRun>;
}

export interface EvaluationSeriesRuntimePorts {
  readonly analysisNodesByNodeId: ReadonlyMap<string, SeriesAnalysisNodeRuntime>;
  readonly decisionPoliciesByDecisionPolicyId: ReadonlyMap<string, SeriesDecisionRuntime>;
  readonly schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
  readonly clock: EvaluationSeriesClock;
}

export interface EvaluationSeriesClock {
  timestamp(): string;
}

export interface EvaluationSeriesEventWriter {
  write(event: Readonly<EvaluationEvent>): Promise<void>;
}

export interface EvaluationSeriesRunOptions {
  readonly runId: string;
  readonly bundleId: string;
  readonly reportId: string;
  readonly signal?: AbortSignal;
  readonly eventWriter?: EvaluationSeriesEventWriter;
  readonly eventBufferCapacity?: number;
}

export interface CompletedEvaluationSeriesRunResult {
  readonly status: 'completed';
  readonly analysis: SeriesAnalysisBundle;
  readonly decision?: SeriesDecisionResult;
  readonly report: EvaluationSeriesReport;
}

export type EvaluationSeriesRunResult = CompletedEvaluationSeriesRunResult | {
  readonly status: 'cancelled';
  readonly analysis?: SeriesAnalysisBundle;
  readonly decision?: SeriesDecisionResult;
} | {
  readonly status: 'failed';
  readonly error: EvaluationError;
  readonly analysis?: SeriesAnalysisBundle;
  readonly decision?: SeriesDecisionResult;
};

export interface EvaluationSeriesRun {
  readonly events: AsyncIterable<EvaluationEvent>;
  readonly result: Promise<EvaluationSeriesRunResult>;
}

function safeError(runtimeKind: 'analysis' | 'decision'): EvaluationError {
  return {
    code: `series-${runtimeKind}-runtime-failed`,
    stage: 'analysis',
    message: 'Evaluation Series Runtime 执行失败。',
  };
}

function configurationError(code: string): EvaluationError {
  return {
    code,
    stage: 'configuration',
    message: 'Evaluation Series 配置或 Runtime binding 无效。',
  };
}

class SeriesCancelledError extends Error {
  constructor() {
    super('Evaluation Series run cancelled.');
    this.name = 'SeriesCancelledError';
  }
}

class SeriesResourceDisposalError extends Error {
  readonly evaluationError: EvaluationError;

  constructor(runtimeKind: 'analysis' | 'decision') {
    super('Evaluation Series Runtime resource disposal failed.');
    this.name = 'SeriesResourceDisposalError';
    this.evaluationError = {
      code: `series-${runtimeKind}-runtime-dispose-failed`,
      stage: 'infrastructure',
      message: 'Evaluation Series Runtime 资源释放失败。',
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SeriesCancelledError();
}

function snapshotSeriesRuntimePorts(
  ports: EvaluationSeriesRuntimePorts,
): EvaluationSeriesRuntimePorts {
  const analysisNodesByNodeId = new Map(
    [...ports.analysisNodesByNodeId].map(([nodeId, runtime]) => {
      if (typeof runtime?.openRun !== 'function') throw new TypeError('Invalid Series Analysis binding.');
      return [nodeId, Object.freeze({
        identity: deepFreezeCanonicalJson(RuntimeIdentitySchema.parse(runtime.identity)),
        outputSchema: deepFreezeCanonicalJson(SchemaIdentitySchema.parse(runtime.outputSchema)),
        openRun: runtime.openRun.bind(runtime),
      })] as const;
    }),
  );
  const decisionPoliciesByDecisionPolicyId = new Map(
    [...ports.decisionPoliciesByDecisionPolicyId].map(([policyId, runtime]) => {
      if (typeof runtime?.openRun !== 'function') throw new TypeError('Invalid Series Decision binding.');
      return [policyId, Object.freeze({
        identity: deepFreezeCanonicalJson(RuntimeIdentitySchema.parse(runtime.identity)),
        openRun: runtime.openRun.bind(runtime),
      })] as const;
    }),
  );
  if (typeof ports.clock?.timestamp !== 'function') {
    throw new TypeError('Invalid Evaluation Series clock binding.');
  }
  return Object.freeze({
    analysisNodesByNodeId,
    decisionPoliciesByDecisionPolicyId,
    schemaValidators: snapshotSchemaValidators(ports.schemaValidators),
    clock: Object.freeze({ timestamp: ports.clock.timestamp.bind(ports.clock) }),
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const TRUST_LEVEL = { untrusted: 0, unknown: 1, declared: 2, verified: 3 } as const;

function minimumTrust(
  values: readonly ('untrusted' | 'unknown' | 'declared' | 'verified')[],
): 'untrusted' | 'unknown' | 'declared' | 'verified' {
  return [...values].sort((left, right) => TRUST_LEVEL[left] - TRUST_LEVEL[right])[0]
    ?? 'unknown';
}

function memberSourcePrefix(
  member: EvaluationSeriesMemberSource,
  scope: EvaluationSeriesPlan['definition']['comparabilityPolicy']['comparisonScope'],
) {
  if (scope === 'evaluation') {
    return {
      execution: member.sources.execution,
      evaluation: member.sources.evaluation,
    };
  }
  if (scope === 'analysis') {
    return {
      execution: member.sources.execution,
      evaluation: member.sources.evaluation,
      analysis: member.sources.analysis,
    };
  }
  if (member.sources.decision === undefined) return undefined;
  return {
    execution: member.sources.execution,
    evaluation: member.sources.evaluation,
    analysis: member.sources.analysis,
    decision: member.sources.decision,
  };
}

function validateMembers(
  plan: EvaluationSeriesPlan,
  input: readonly EvaluationSeriesMemberSource[],
): EvaluationSeriesMemberSource[] {
  for (const member of input) assertEvaluationSeriesMemberSource(member);
  const members = [...input].sort((left, right) => (
    left.reference.replicateIndex - right.reference.replicateIndex
    || compareStrings(left.reference.memberId, right.reference.memberId)
  ));
  if (new Set(members.map((member) => member.reference.memberId)).size !== members.length
      || new Set(members.map((member) => member.reference.replicateIndex)).size !== members.length
      || new Set(members.map((member) => member.reference.reportDigest)).size !== members.length) {
    throw new TypeError('Evaluation Series contains duplicate member identity.');
  }
  const slots = new Map(plan.definition.members.map((slot) => [slot.memberId, slot]));
  for (const member of members) {
    const slot = slots.get(member.reference.memberId);
    if (slot === undefined
        || slot.replicateIndex !== member.reference.replicateIndex
        || (slot.expectedRunContractDigest !== undefined
          && slot.expectedRunContractDigest !== member.reference.runContractDigest)) {
      throw new TypeError('Evaluation Series member does not match its sealed slot.');
    }
    if (plan.definition.analysisMode === 'preregistered') {
      const membership = member.plan.definition.seriesMembership;
      if (membership === undefined
          || membership.seriesDesignDigest !== plan.definition.seriesDesignDigest
          || membership.memberId !== slot.memberId
          || membership.replicateIndex !== slot.replicateIndex) {
        throw new TypeError(
          'Preregistered Series members must bind the Series design before Run execution.',
        );
      }
    }
  }
  return members;
}

function comparableMembers(
  plan: EvaluationSeriesPlan,
  members: readonly EvaluationSeriesMemberSource[],
): { memberIds: Set<string>; assessments: SeriesComparabilityAssessment[] } {
  const memberIds = new Set<string>();
  const assessments: SeriesComparabilityAssessment[] = [];
  const anchor = members[0];
  if (anchor === undefined) return { memberIds, assessments };
  memberIds.add(anchor.reference.memberId);
  const scope = plan.definition.comparabilityPolicy.comparisonScope;
  const targetIds = anchor.plan.execution.targets.map((target) => target.targetId).sort(compareStrings);
  for (const candidate of members.slice(1)) {
    const leftSource = memberSourcePrefix(anchor, scope);
    const rightSource = memberSourcePrefix(candidate, scope);
    const policy = createComparabilityPolicy({
      schemaVersion: 'omk.comparability-policy/v1',
      designMode: 'exact-measurement-design',
      comparisonScope: scope,
      subjects: targetIds.map((targetId) => ({
        subjectId: targetId,
        leftTargetId: targetId,
        rightTargetId: targetId,
      })),
    });
    const assessment = assessComparability(
      policy,
      anchor.plan,
      candidate.plan,
      leftSource,
      rightSource,
    ).assessment;
    assessments.push({
      anchorMemberId: anchor.reference.memberId,
      memberId: candidate.reference.memberId,
      assessment,
    });
    if (assessment.comparabilityStatus === 'compatible'
        || (assessment.comparabilityStatus === 'conditional'
          && plan.definition.comparabilityPolicy.minimumStatus === 'conditional')) {
      memberIds.add(candidate.reference.memberId);
    }
  }
  return { memberIds, assessments };
}

function recordDigest(record: Omit<SeriesAnalysisRecord, 'recordDigest'>): Sha256Digest {
  return digestCanonicalJson(record);
}

function topologicalSeriesNodes(
  plan: EvaluationSeriesPlan,
): EvaluationSeriesPlan['definition']['analysisGraph']['nodes'] {
  const producerByResult = new Map(plan.definition.analysisGraph.nodes.map((node) => [
    node.outputResultId,
    node.nodeId,
  ]));
  const nodeById = new Map(plan.definition.analysisGraph.nodes.map((node) => [node.nodeId, node]));
  const remaining = new Set(nodeById.keys());
  const ordered: EvaluationSeriesPlan['definition']['analysisGraph']['nodes'][number][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((nodeId) => {
      const node = nodeById.get(nodeId);
      if (node === undefined) return false;
      return node.inputs.every((input) => input.seriesInputKind === 'members'
        || !remaining.has(producerByResult.get(input.referenceId) ?? ''));
    }).sort(compareStrings);
    if (ready.length === 0) throw new TypeError('Series analysis graph must be acyclic.');
    for (const nodeId of ready) {
      const node = nodeById.get(nodeId);
      if (node === undefined) throw new TypeError('Series analysis node is missing.');
      ordered.push(node);
      remaining.delete(nodeId);
    }
  }
  return ordered;
}

async function runAnalysisNodes(
  plan: EvaluationSeriesPlan,
  members: readonly EvaluationSeriesMemberSource[],
  comparableIds: ReadonlySet<string>,
  coverage: SeriesAnalysisBundle['coverage'],
  ports: EvaluationSeriesRuntimePorts,
  options: Pick<EvaluationSeriesRunOptions, 'runId' | 'bundleId'>,
  signal: AbortSignal,
  events: SeriesEventEmitter,
): Promise<SeriesAnalysisRecord[]> {
  const comparable = members.filter((member) => comparableIds.has(member.reference.memberId));
  const records: SeriesAnalysisRecord[] = [];
  const recordsByResult = new Map<string, SeriesAnalysisRecord>();
  for (const node of topologicalSeriesNodes(plan)) {
    throwIfAborted(signal);
    const eligible = comparable.filter((member) => (
      member.reference.status.runStatus === 'completed'
      && (member.reference.status.evidenceStatus === 'complete'
        || (member.reference.status.evidenceStatus === 'partial'
          && node.minimumMemberEvidenceStatus === 'partial'))
    ));
    const candidateBinding = plan.runtimes.find((binding) => binding.referenceId === node.nodeId);
    if (candidateBinding?.runtimeKind !== 'series-analysis-node') {
      throw new TypeError('Series Analysis Runtime binding is missing from the sealed plan.');
    }
    const assumptionChecks: SeriesAnalysisRecord['assumptionChecks'] = [];
    const inputs: SeriesAnalysisNodeInput[] = [];
    const unavailableResults: string[] = [];
    const parentDigests = new Set<Sha256Digest>();
    for (const input of node.inputs) {
      if (input.seriesInputKind === 'members') {
        inputs.push({ ...input, members: eligible });
        for (const member of eligible) {
          parentDigests.add(member.reference.reportDigest as Sha256Digest);
        }
      } else {
        const parent = recordsByResult.get(input.referenceId);
        if (parent?.analysisStatus !== 'completed') {
          unavailableResults.push(input.referenceId);
        } else {
          inputs.push({ ...input, record: parent });
          parentDigests.add(parent.recordDigest as Sha256Digest);
        }
      }
    }
    const base = {
      resultId: node.outputResultId,
      nodeId: node.nodeId,
      analysisStandardId: node.analysisStandardId,
      implementation: candidateBinding.identity,
      outputSchema: candidateBinding.outputSchema,
      inputReferences: node.inputs,
      memberIds: eligible.map((member) => member.reference.memberId).sort(compareStrings),
      coverage,
      assumptionChecks,
      analysisMode: plan.definition.analysisMode,
      parentDigests: [...parentDigests].sort(compareStrings),
    };
    if (unavailableResults.length > 0
        || (node.inputs.some((input) => input.seriesInputKind === 'members')
          && eligible.length < 2)) {
      const payload = {
        ...base,
        runtimeExecutionStatus: 'not-executed' as const,
        analysisStatus: 'inconclusive' as const,
        reasonCodes: unavailableResults.length > 0
          ? ['series-analysis-dependency-unavailable']
          : ['series-comparable-members-insufficient'],
      };
      const record = parseWireDocument(SeriesAnalysisRecordSchema, {
        ...payload,
        recordDigest: recordDigest(payload),
      });
      records.push(record);
      recordsByResult.set(record.resultId, record);
      await emitSeriesEvent(events,
        'series.analysis-node.inconclusive',
        'series-analysis-node',
        node.nodeId,
        { reasonCodes: payload.reasonCodes },
      );
      continue;
    }
    const runtime = ports.analysisNodesByNodeId.get(node.nodeId);
    if (runtime === undefined
        || canonicalizeJson(runtime.identity) !== canonicalizeJson(candidateBinding.identity)
        || canonicalizeJson(runtime.outputSchema)
          !== canonicalizeJson(candidateBinding.outputSchema)) {
      throw new TypeError('Series Analysis Runtime does not match the sealed plan.');
    }
    const validator = ports.schemaValidators.get(schemaIdentityKey(candidateBinding.outputSchema));
    if (validator === undefined
        || canonicalizeJson(validator.schema) !== canonicalizeJson(candidateBinding.outputSchema)) {
      throw new TypeError('Series Analysis output schema validator is missing or mismatched.');
    }
    await emitSeriesEvent(events,
      'series.analysis-node.started',
      'series-analysis-node',
      node.nodeId,
      {},
    );
    let session: SeriesAnalysisNodeRun | undefined;
    let output: SeriesAnalysisNodeOutput | undefined;
    let failure: EvaluationError | undefined;
    let cancellation: SeriesCancelledError | undefined;
    try {
      session = await runtime.openRun(Object.freeze({
        runId: options.runId,
        seriesPlanDigest: plan.seriesPlanDigest as Sha256Digest,
        bundleId: options.bundleId,
        nodeId: node.nodeId,
        analysisMode: plan.definition.analysisMode,
      }));
      if (typeof session?.analyze !== 'function' || typeof session?.dispose !== 'function') {
        throw new TypeError('Series Analysis openRun returned an invalid session.');
      }
      throwIfAborted(signal);
      const runtimeInputs = Object.freeze(inputs.map((input) => Object.freeze(
        input.seriesInputKind === 'members'
          ? { ...input, members: Object.freeze([...input.members]) }
          : { ...input },
      )));
      output = parseWireDocument(
        SeriesAnalysisNodeOutputSchema,
        await session.analyze(Object.freeze({
          plan,
          node,
          members: Object.freeze([...eligible]),
          coverage,
          inputs: runtimeInputs,
          signal,
        })),
      );
      throwIfAborted(signal);
    } catch (error) {
      if (error instanceof SeriesCancelledError || signal.aborted) {
        cancellation = new SeriesCancelledError();
      } else {
        failure = safeError('analysis');
      }
    } finally {
      if (session !== undefined) {
        try {
          await session.dispose();
        } catch {
          throw new SeriesResourceDisposalError('analysis');
        }
      }
    }
    if (cancellation !== undefined) throw cancellation;
    if (failure !== undefined || output === undefined) {
      const payload = {
        ...base,
        runtimeExecutionStatus: 'executed' as const,
        analysisStatus: 'failed' as const,
        error: failure ?? safeError('analysis'),
      };
      const record = parseWireDocument(SeriesAnalysisRecordSchema, {
        ...payload,
        recordDigest: recordDigest(payload),
      });
      records.push(record);
      recordsByResult.set(record.resultId, record);
      await emitSeriesEvent(events,
        'series.analysis-node.failed',
        'series-analysis-node',
        node.nodeId,
        { reasonCode: payload.error.code },
      );
      continue;
    }
    try {
      const checks = (output.assumptionChecks ?? []).map((check) => parseWireDocument(
        AssumptionCheckSchema,
        { ...check, nodeId: node.nodeId },
      )).sort((left, right) => compareStrings(left.assumptionId, right.assumptionId));
      const assumptionsPassed = checks.every((check) => check.checkStatus === 'passed');
      const normalized = output.analysisStatus === 'completed' && assumptionsPassed
        ? {
          ...base,
          assumptionChecks: checks,
          runtimeExecutionStatus: 'executed' as const,
          analysisStatus: 'completed' as const,
          resultType: output.resultType,
          value: output.value,
        }
        : output.analysisStatus === 'completed'
          ? {
            ...base,
            assumptionChecks: checks,
            runtimeExecutionStatus: 'executed' as const,
            analysisStatus: 'inconclusive' as const,
            reasonCodes: ['series-analysis-assumption-failed'],
          }
          : {
            ...base,
            assumptionChecks: checks,
            runtimeExecutionStatus: 'executed' as const,
            analysisStatus: 'inconclusive' as const,
            reasonCodes: [...output.reasonCodes].sort(compareStrings),
          };
      if (normalized.analysisStatus === 'completed') {
        const envelope = { resultType: normalized.resultType, value: normalized.value };
        if (canonicalizeJson(validator.parse(envelope, {
          validationKind: 'analysis-output',
          parameters: node.parameters ?? {},
          inputFacts: {
            resamplingUnitCount: eligible.length,
            analysisResultInputs: inputs.flatMap((input) => (
              input.seriesInputKind === 'analysis-result'
                ? [{
                  referenceId: input.referenceId,
                  resultType: input.record.resultType,
                  value: input.record.value,
                }]
                : []
            )),
          },
        })) !== canonicalizeJson(envelope)) {
          throw new TypeError('Series Analysis output validator must preserve the sealed envelope.');
        }
      }
      const record = parseWireDocument(SeriesAnalysisRecordSchema, {
        ...normalized,
        recordDigest: recordDigest(normalized),
      });
      records.push(record);
      recordsByResult.set(record.resultId, record);
      await emitSeriesEvent(events,
        normalized.analysisStatus === 'completed'
          ? 'series.analysis-node.completed'
          : 'series.analysis-node.inconclusive',
        'series-analysis-node',
        node.nodeId,
        normalized.analysisStatus === 'completed'
          ? { resultId: record.resultId }
          : { reasonCodes: normalized.reasonCodes },
      );
    } catch {
      const payload = {
        ...base,
        runtimeExecutionStatus: 'executed' as const,
        analysisStatus: 'failed' as const,
        error: safeError('analysis'),
      };
      const record = parseWireDocument(SeriesAnalysisRecordSchema, {
        ...payload,
        recordDigest: recordDigest(payload),
      });
      records.push(record);
      recordsByResult.set(record.resultId, record);
      await emitSeriesEvent(events,
        'series.analysis-node.failed',
        'series-analysis-node',
        node.nodeId,
        { reasonCode: payload.error.code },
      );
    }
  }
  return records.sort((left, right) => compareStrings(left.nodeId, right.nodeId));
}

function makeBundle(
  plan: EvaluationSeriesPlan,
  members: readonly EvaluationSeriesMemberSource[],
  coverage: SeriesAnalysisBundle['coverage'],
  records: readonly SeriesAnalysisRecord[],
  comparability: readonly SeriesComparabilityAssessment[],
  bundleId: string,
): SeriesAnalysisBundle {
  const parentDigests = members.map((member) => member.reference.reportDigest).sort(compareStrings);
  const trust = minimumTrust([
    ...members.map((member) => member.reference.effectiveTrust),
    ...records
      .filter((record) => record.runtimeExecutionStatus === 'executed')
      .map((record) => record.implementation.assuranceLevel),
  ]);
  const payload = {
    schemaVersion: SERIES_ANALYSIS_BUNDLE_SCHEMA_VERSION,
    bundleId,
    seriesPlanDigest: plan.seriesPlanDigest,
    members: members.map((member) => member.reference),
    comparability,
    coverage,
    records,
    provenance: {
      provenanceKind: 'derived' as const,
      trust,
      parentDigests,
    },
  };
  return parseSeriesAnalysisBundleDocument({
    ...payload,
    bundleDigest: digestSeriesArtifact(payload as unknown as Record<string, JsonValue>, 'bundleDigest'),
  });
}

async function makeDecision(
  plan: EvaluationSeriesPlan,
  bundle: SeriesAnalysisBundle,
  ports: EvaluationSeriesRuntimePorts,
  options: Pick<EvaluationSeriesRunOptions, 'runId'>,
  signal: AbortSignal,
  events: SeriesEventEmitter,
): Promise<SeriesDecisionResult | undefined> {
  const policy = plan.definition.decisionPolicy;
  if (policy === undefined) return undefined;
  const binding = plan.runtimes.find((runtime) => (
    runtime.runtimeKind === 'series-decision-policy'
      && runtime.referenceId === policy.decisionPolicyId
  ));
  if (binding?.runtimeKind !== 'series-decision-policy') {
    throw new TypeError('Series Decision Runtime binding is missing from the sealed plan.');
  }
  const records = bundle.records.filter(
    (record): record is Extract<SeriesAnalysisRecord, { analysisStatus: 'completed' }> => (
      record.analysisStatus === 'completed'
    ),
  );
  const comparableMemberIds = new Set(bundle.records
    .filter((record) => policy.analysisResultIds.includes(record.resultId))
    .flatMap((record) => record.memberIds));
  const qualifiedMembers = bundle.members.filter((member) => (
    comparableMemberIds.has(member.memberId)
    && member.status.runStatus === 'completed'
    && (member.status.evidenceStatus === 'complete'
      || (member.status.evidenceStatus === 'partial'
        && policy.minimumMemberEvidenceStatus === 'partial'))
  )).length;
  const coverageRatio = bundle.coverage.planned === 0
    ? 0
    : qualifiedMembers / bundle.coverage.planned;
  const required = new Set(policy.analysisResultIds);
  const gatesPassed = coverageRatio >= policy.minimumCoverageRatio
    && [...required].every((resultId) => records.some((record) => record.resultId === resultId))
    && records.every((record) => record.assumptionChecks.every((check) => check.checkStatus === 'passed'));
  const policyDigest = digestCanonicalJson({
    seriesPlanDigest: plan.seriesPlanDigest,
    policy,
    runtime: binding.identity,
  });
  const base = {
    decisionPolicyId: policy.decisionPolicyId,
    implementation: binding.identity,
    seriesPlanDigest: plan.seriesPlanDigest,
    analysisBundleDigest: bundle.bundleDigest,
    analysisResultIds: [...policy.analysisResultIds].sort(compareStrings),
    policyDigest,
  };
  if (!gatesPassed) {
    const payload = {
      ...base,
      policyExecutionStatus: 'not-executed' as const,
      decisionStatus: 'not-decided' as const,
      reasonCodes: ['series-coverage-or-assumption-gate-failed'],
    };
    const decision = parseWireDocument(SeriesDecisionResultSchema, {
      ...payload,
      decisionDigest: digestSeriesArtifact(
        payload as unknown as Record<string, JsonValue>,
        'decisionDigest',
      ),
    });
    await emitSeriesEvent(events,
      'series.decision.not-decided',
      'series-decision-policy',
      policy.decisionPolicyId,
      { reasonCodes: payload.reasonCodes },
    );
    return decision;
  }
  const runtime = ports.decisionPoliciesByDecisionPolicyId.get(policy.decisionPolicyId);
  if (runtime === undefined
      || canonicalizeJson(binding.identity) !== canonicalizeJson(runtime.identity)) {
    throw new TypeError('Series Decision Runtime does not match the sealed plan.');
  }
  throwIfAborted(signal);
  await emitSeriesEvent(events,
    'series.decision.started',
    'series-decision-policy',
    policy.decisionPolicyId,
    {},
  );
  let session: SeriesDecisionRun | undefined;
  let output: SeriesDecisionOutput | undefined;
  let cancellation: SeriesCancelledError | undefined;
  try {
    session = await runtime.openRun(Object.freeze({
      runId: options.runId,
      seriesPlanDigest: plan.seriesPlanDigest as Sha256Digest,
      analysisBundleDigest: bundle.bundleDigest as Sha256Digest,
      decisionPolicyId: policy.decisionPolicyId,
    }));
    if (typeof session?.decide !== 'function' || typeof session?.dispose !== 'function') {
      throw new TypeError('Series Decision openRun returned an invalid session.');
    }
    throwIfAborted(signal);
    output = parseWireDocument(SeriesDecisionOutputSchema, await session.decide(
      Object.freeze({ plan, bundle, records, signal }),
    ));
    throwIfAborted(signal);
  } catch (error) {
    if (error instanceof SeriesCancelledError || signal.aborted) {
      cancellation = new SeriesCancelledError();
    }
  } finally {
    if (session !== undefined) {
      try {
        await session.dispose();
      } catch {
        throw new SeriesResourceDisposalError('decision');
      }
    }
  }
  if (cancellation !== undefined) throw cancellation;
  if (output === undefined) {
    const payload = {
      ...base,
      policyExecutionStatus: 'executed' as const,
      decisionStatus: 'failed' as const,
      error: safeError('decision'),
    };
    const decision = parseWireDocument(SeriesDecisionResultSchema, {
      ...payload,
      decisionDigest: digestSeriesArtifact(
        payload as unknown as Record<string, JsonValue>,
        'decisionDigest',
      ),
    });
    await emitSeriesEvent(events,
      'series.decision.failed',
      'series-decision-policy',
      policy.decisionPolicyId,
      { reasonCode: payload.error.code },
    );
    return decision;
  }
  const payload = output.decisionStatus === 'decided'
    ? {
      ...base,
      policyExecutionStatus: 'executed' as const,
      decisionStatus: 'decided' as const,
      verdict: output.verdict,
      reasonCodes: [...new Set(output.reasonCodes)].sort(compareStrings),
    }
    : {
      ...base,
      policyExecutionStatus: 'executed' as const,
      decisionStatus: 'not-decided' as const,
      reasonCodes: [...output.reasonCodes].sort(compareStrings),
    };
  const decision = parseWireDocument(SeriesDecisionResultSchema, {
    ...payload,
    decisionDigest: digestSeriesArtifact(
      payload as unknown as Record<string, JsonValue>,
      'decisionDigest',
    ),
  });
  await emitSeriesEvent(events,
    output.decisionStatus === 'decided'
      ? 'series.decision.completed'
      : 'series.decision.not-decided',
    'series-decision-policy',
    policy.decisionPolicyId,
    { reasonCodes: payload.reasonCodes },
  );
  return decision;
}

async function executeEvaluationSeries(
  plan: EvaluationSeriesPlan,
  members: readonly EvaluationSeriesMemberSource[],
  comparability: ReturnType<typeof comparableMembers>,
  coverage: SeriesAnalysisBundle['coverage'],
  ports: EvaluationSeriesRuntimePorts,
  options: EvaluationSeriesRunOptions,
  signal: AbortSignal,
  events: SeriesEventEmitter,
): Promise<EvaluationSeriesRunResult> {
  let analysis: SeriesAnalysisBundle | undefined;
  let decision: SeriesDecisionResult | undefined;
  try {
    await emitSeriesEvent(events,
      'series.run.started',
      'evaluation-series-run',
      options.runId,
      { seriesPlanDigest: plan.seriesPlanDigest },
    );
    throwIfAborted(signal);
    const records = await runAnalysisNodes(
      plan,
      members,
      comparability.memberIds,
      coverage,
      ports,
      options,
      signal,
      events,
    );
    analysis = makeBundle(
      plan,
      members,
      coverage,
      records,
      comparability.assessments,
      options.bundleId,
    );
    throwIfAborted(signal);
    decision = await makeDecision(plan, analysis, ports, options, signal, events);
    throwIfAborted(signal);
    const payload = {
      schemaVersion: EVALUATION_SERIES_REPORT_SCHEMA_VERSION,
      reportId: options.reportId,
      seriesPlanDigest: plan.seriesPlanDigest,
      analysisBundleDigest: analysis.bundleDigest,
      ...(decision !== undefined ? { decision } : {}),
      provenance: {
        provenanceKind: 'derived' as const,
        trust: minimumTrust([
          analysis.provenance.trust,
          ...(decision?.policyExecutionStatus === 'executed'
            ? [decision.implementation.assuranceLevel]
            : []),
        ]),
        parentDigests: [
          analysis.bundleDigest,
          ...(decision === undefined ? [] : [decision.decisionDigest]),
        ],
      },
    };
    const report = parseEvaluationSeriesReportDocument({
      ...payload,
      reportDigest: digestSeriesArtifact(
        payload as unknown as Record<string, JsonValue>,
        'reportDigest',
      ),
    });
    await emitSeriesEvent(events,
      'series.run.completed',
      'evaluation-series-run',
      options.runId,
      { reportDigest: report.reportDigest },
    );
    return deepFreezeCanonicalJson({
      status: 'completed',
      analysis,
      ...(decision !== undefined ? { decision } : {}),
      report,
    });
  } catch (error) {
    if (!(error instanceof SeriesResourceDisposalError)
        && (error instanceof SeriesCancelledError || signal.aborted)) {
      await emitSeriesEvent(
        events,
        'series.run.cancelled',
        'evaluation-series-run',
        options.runId,
        {},
      );
      return deepFreezeCanonicalJson({
        status: 'cancelled',
        ...(analysis === undefined ? {} : { analysis }),
        ...(decision === undefined ? {} : { decision }),
      });
    }
    const failure = error instanceof SeriesResourceDisposalError
      ? error.evaluationError
      : {
        code: 'series-run-failed',
        stage: 'infrastructure' as const,
        message: 'Evaluation Series 运行失败。',
      };
    await emitSeriesEvent(
      events,
      'series.run.failed',
      'evaluation-series-run',
      options.runId,
      { reasonCode: failure.code },
    );
    return deepFreezeCanonicalJson({
      status: 'failed',
      error: failure,
      ...(analysis === undefined ? {} : { analysis }),
      ...(decision === undefined ? {} : { decision }),
    });
  } finally {
    events.close();
  }
}

function configurationFailureRun(code: string): EvaluationSeriesRun {
  const events = new BoundedEventStream(DEFAULT_EVENT_BUFFER_CAPACITY);
  events.close();
  return Object.freeze({
    events,
    result: Promise.resolve(deepFreezeCanonicalJson({
      status: 'failed' as const,
      error: configurationError(code),
    })),
  });
}

export function startEvaluationSeries(
  planInput: unknown,
  memberInputs: readonly EvaluationSeriesMemberSource[],
  inputPorts: EvaluationSeriesRuntimePorts,
  inputOptions: EvaluationSeriesRunOptions,
): EvaluationSeriesRun {
  if (inputOptions === null || typeof inputOptions !== 'object') {
    return configurationFailureRun('series-run-options-invalid');
  }
  if (inputOptions.signal !== undefined
      && (typeof inputOptions.signal.aborted !== 'boolean'
        || typeof inputOptions.signal.addEventListener !== 'function')) {
    return configurationFailureRun('series-run-signal-invalid');
  }
  if (inputOptions.eventWriter !== undefined
      && typeof inputOptions.eventWriter.write !== 'function') {
    return configurationFailureRun('series-event-writer-invalid');
  }
  const capacity = inputOptions.eventBufferCapacity ?? DEFAULT_EVENT_BUFFER_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    return configurationFailureRun('series-event-buffer-capacity-invalid');
  }
  if (!IdentifierSchema.safeParse(inputOptions.runId).success
      || !IdentifierSchema.safeParse(inputOptions.bundleId).success
      || !IdentifierSchema.safeParse(inputOptions.reportId).success) {
    return configurationFailureRun('series-run-identity-invalid');
  }
  let plan: EvaluationSeriesPlan;
  let members: EvaluationSeriesMemberSource[];
  let ports: EvaluationSeriesRuntimePorts;
  let comparability: ReturnType<typeof comparableMembers>;
  let coverage: SeriesAnalysisBundle['coverage'];
  try {
    plan = parseEvaluationSeriesPlan(planInput);
    const memberSnapshot = deepFreezeCanonicalJson(
      memberInputs as unknown as JsonValue,
    ) as unknown as readonly EvaluationSeriesMemberSource[];
    members = validateMembers(plan, memberSnapshot);
    ports = snapshotSeriesRuntimePorts(inputPorts);
    comparability = comparableMembers(plan, members);
    coverage = deriveSeriesMemberCoverage(plan, members, comparability.memberIds);
  } catch {
    return configurationFailureRun('series-run-configuration-invalid');
  }
  const options: EvaluationSeriesRunOptions = Object.freeze({
    runId: inputOptions.runId,
    bundleId: inputOptions.bundleId,
    reportId: inputOptions.reportId,
    ...(inputOptions.signal === undefined ? {} : { signal: inputOptions.signal }),
    ...(inputOptions.eventWriter === undefined ? {} : { eventWriter: inputOptions.eventWriter }),
    eventBufferCapacity: capacity,
  });
  const stream = new BoundedEventStream(capacity);
  const emitter = new RuntimeEventEmitter(
    ports.clock,
    new InMemoryRuntimeEventSequencer(),
    options.eventWriter,
    {
      runId: options.runId,
      writerMode: options.eventWriter === undefined ? 'disabled' : 'optional',
      writerFailureMode: 'ignore',
      writerFailureReason: 'series-event-writer-failed',
      writerFailureError: {
        code: 'series-event-writer-failed',
        stage: 'infrastructure',
        message: 'Evaluation Series EventWriter 执行失败。',
      },
      recoveryEventKinds: [],
    },
    stream,
    () => undefined,
  );
  const signal = options.signal ?? new AbortController().signal;
  return Object.freeze({
    events: stream,
    result: executeEvaluationSeries(
      plan,
      members,
      comparability,
      coverage,
      ports,
      options,
      signal,
      emitter,
    ),
  });
}

export async function runEvaluationSeries(
  planInput: unknown,
  memberInputs: readonly EvaluationSeriesMemberSource[],
  ports: EvaluationSeriesRuntimePorts,
  options: EvaluationSeriesRunOptions,
): Promise<EvaluationSeriesRunResult> {
  return startEvaluationSeries(planInput, memberInputs, ports, options).result;
}
