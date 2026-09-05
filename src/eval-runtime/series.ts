import {
  EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION,
  IdentifierSchema,
  JsonValueSchema,
  canonicalizeJson,
  createEvaluationSeriesDefinition,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  prepareEvaluationSeriesPlan,
  type EvaluationSeriesDefinition,
  type EvaluationSeriesMemberSource,
  type EvaluationSeriesPlan,
  type JsonValue,
  type SeriesAnalysisRecord,
} from '../eval-core/contracts/index.js';
import {
  createRunStabilityRuntime,
  createRunStabilitySchemaValidators,
  runEvaluationSeries,
  type CompletedEvaluationSeriesRunResult,
  type EvaluationSeriesRunResult as CoreEvaluationSeriesRunResult,
  type RunStabilityValue,
} from '../eval-core/series/index.js';
import {
  EvaluationConfigurationError,
  createCanonicalEvaluationSeriesMemberSource,
  prepareEvaluationSeriesTemplate,
  type Clock,
  type EvaluateInput,
  type EvaluationResult,
  type EvaluationWorkEstimate,
  type PreparedEvaluation,
  type PreparedEvaluationPlan,
} from './evaluate.js';
import { createNodeEvaluationClock } from './clock.js';

const SERIES_STABILITY_NODE_ID = 'run-stability';
const SERIES_SCHEDULING_EXTENSION_URI =
  'urn:omk:eval-runtime:series-member-scheduling:v1';
const SERIES_SCHEDULING_SCHEMA_DIGEST = digestCanonicalJson({
  schemaVersion: 'omk.eval-runtime.series-member-scheduling/v1',
  schedulingKind: 'sequential',
  cachePolicy: 'disabled',
  inferenceKind: 'descriptive-fixed-design-repeatability',
});
const MAX_REPEAT_COUNT = 1_000;

export interface EvaluationSeriesStability {
  /** Existing per-Run Analysis result selected before any member starts. */
  readonly sourceAnalysisId: string;
  /** Explicitly selects a numeric scalar or an interval's point estimate. */
  readonly projection: 'scalar' | 'interval-estimate';
  readonly minimumMemberEvidenceStatus?: 'complete' | 'partial';
  readonly minimumComparabilityStatus?: 'compatible' | 'conditional';
}

export interface EvaluationSeriesInput {
  readonly evaluation: EvaluateInput;
  /** Caller-owned identity for this one preregistered Series instance. */
  readonly seriesInstanceId: string;
  readonly repeatCount: number;
  readonly stability: EvaluationSeriesStability;
}

export interface EvaluationSeriesRunOptions {
  readonly signal?: AbortSignal;
  readonly annotations?: JsonValue;
  readonly summaries?: JsonValue;
  readonly clock?: Clock;
}

export interface EvaluationSeriesWorkEstimate {
  readonly repeatCount: number;
  readonly perRun: EvaluationWorkEstimate;
  readonly executionCoordinates: number;
  readonly evaluationCoordinates: number;
  readonly plannedInvocations: number;
  readonly uncertain: EvaluationWorkEstimate['uncertain'];
}

interface EvaluationSeriesMemberBase {
  readonly memberId: string;
  readonly replicateIndex: number;
  readonly runId: string;
  readonly plan: PreparedEvaluationPlan;
}

export type EvaluationSeriesMemberResult = Readonly<
  | EvaluationSeriesMemberBase & {
      memberStatus: 'produced';
      admissionStatus: 'admitted';
      result: EvaluationResult;
    }
  | EvaluationSeriesMemberBase & {
      memberStatus: 'produced';
      admissionStatus: 'rejected';
      reasonCode: 'series-member-source-unavailable' | 'series-member-lineage-duplicate';
      result: EvaluationResult;
    }
  | EvaluationSeriesMemberBase & {
      memberStatus: 'not-produced';
      admissionStatus: 'not-attempted';
      reasonCode: 'series-member-cancelled-before-start';
    }
>;

type CompletedSeriesAnalysisRecord = Extract<
  SeriesAnalysisRecord,
  { analysisStatus: 'completed' }
>;

export type EvaluationSeriesStabilityResult =
  | Readonly<Omit<CompletedSeriesAnalysisRecord, 'resultType' | 'value'> & {
      resultType: 'table';
      value: RunStabilityValue;
    }>
  | Exclude<SeriesAnalysisRecord, CompletedSeriesAnalysisRecord>;

interface EvaluationSeriesResultBase {
  seriesId: string;
  definition: EvaluationSeriesDefinition;
  plan: EvaluationSeriesPlan;
  memberExecutionStatus: 'completed' | 'cancelled';
  members: readonly EvaluationSeriesMemberResult[];
  analysisResults: Readonly<Record<string, SeriesAnalysisRecord>>;
}

export type EvaluationSeriesResult = Readonly<
  | CompletedEvaluationSeriesRunResult & EvaluationSeriesResultBase & {
      stability: EvaluationSeriesStabilityResult;
    }
  | Exclude<CoreEvaluationSeriesRunResult, CompletedEvaluationSeriesRunResult>
      & EvaluationSeriesResultBase & {
        stability?: EvaluationSeriesStabilityResult;
      }
>;

export interface PreparedEvaluationSeries {
  readonly seriesId: string;
  readonly definition: EvaluationSeriesDefinition;
  readonly plan: EvaluationSeriesPlan;
  readonly memberPlans: readonly PreparedEvaluationPlan[];
  readonly estimatedWork: EvaluationSeriesWorkEstimate;
  run(options?: Readonly<EvaluationSeriesRunOptions>): Promise<EvaluationSeriesResult>;
}

export type { RunStabilityValue };

function fail(message: string): never {
  throw new EvaluationConfigurationError('EVAL_RUNTIME_SERIES_INVALID', message);
}

function captureSeriesInput(
  input: Readonly<EvaluationSeriesInput>,
): Readonly<EvaluationSeriesInput> {
  if (input === null
      || typeof input !== 'object'
      || Object.keys(input).some((key) => ![
        'evaluation',
        'seriesInstanceId',
        'repeatCount',
        'stability',
      ].includes(key))
      || !IdentifierSchema.safeParse(input.seriesInstanceId).success
      || input.seriesInstanceId.length > 192
      || !Number.isSafeInteger(input.repeatCount)
      || input.repeatCount < 2
      || input.repeatCount > MAX_REPEAT_COUNT
      || input.stability === null
      || typeof input.stability !== 'object'
      || Object.keys(input.stability).some((key) => ![
        'sourceAnalysisId',
        'projection',
        'minimumMemberEvidenceStatus',
        'minimumComparabilityStatus',
      ].includes(key))
      || !IdentifierSchema.safeParse(input.stability.sourceAnalysisId).success
      || !['scalar', 'interval-estimate'].includes(input.stability.projection)
      || (input.stability.minimumMemberEvidenceStatus !== undefined
        && !['complete', 'partial'].includes(input.stability.minimumMemberEvidenceStatus))
      || (input.stability.minimumComparabilityStatus !== undefined
        && !['compatible', 'conditional'].includes(input.stability.minimumComparabilityStatus))) {
    fail('Evaluation Series 输入无效。');
  }
  const cache = input.evaluation?.policy?.cache;
  if ((cache?.execution !== undefined && cache.execution !== 'disabled')
      || (cache?.evaluation !== undefined && cache.evaluation !== 'disabled')) {
    fail('Evaluation Series repeatability 要求 execution 与 evaluation cache 均为 disabled。');
  }
  return Object.freeze({
    evaluation: input.evaluation,
    seriesInstanceId: input.seriesInstanceId,
    repeatCount: input.repeatCount,
    stability: Object.freeze({
      sourceAnalysisId: input.stability.sourceAnalysisId,
      projection: input.stability.projection,
      ...(input.stability.minimumMemberEvidenceStatus === undefined ? {} : {
        minimumMemberEvidenceStatus: input.stability.minimumMemberEvidenceStatus,
      }),
      ...(input.stability.minimumComparabilityStatus === undefined ? {} : {
        minimumComparabilityStatus: input.stability.minimumComparabilityStatus,
      }),
    }),
  });
}

function assertSeriesOptions(
  options: Readonly<EvaluationSeriesRunOptions> | undefined,
): Readonly<EvaluationSeriesRunOptions> {
  const value = options ?? {};
  if (value === null
      || typeof value !== 'object'
      || Object.keys(value).some((key) => ![
        'signal',
        'annotations',
        'summaries',
        'clock',
      ].includes(key))
      || (value.signal !== undefined && (
        value.signal === null
        || typeof value.signal !== 'object'
        || typeof value.signal.aborted !== 'boolean'
        || typeof value.signal.addEventListener !== 'function'
        || typeof value.signal.removeEventListener !== 'function'
      ))
      || (value.clock !== undefined && (
        value.clock === null
        || typeof value.clock !== 'object'
        || typeof value.clock.monotonicNow !== 'function'
        || typeof value.clock.timestamp !== 'function'
        || typeof value.clock.sleep !== 'function'
      ))
      || (value.annotations !== undefined
        && !JsonValueSchema.safeParse(value.annotations).success)
      || (value.summaries !== undefined
        && !JsonValueSchema.safeParse(value.summaries).success)) {
    fail('Evaluation Series run options 无效。');
  }
  return Object.freeze({
    ...(value.signal === undefined ? {} : { signal: value.signal }),
    ...(value.annotations === undefined ? {} : {
      annotations: deepFreezeCanonicalJson(structuredClone(value.annotations)),
    }),
    ...(value.summaries === undefined ? {} : {
      summaries: deepFreezeCanonicalJson(structuredClone(value.summaries)),
    }),
    ...(value.clock === undefined ? {} : { clock: value.clock }),
  });
}

function stageDesign(plan: PreparedEvaluationPlan) {
  return Object.freeze({
    datasetRevisionDigest: plan.digests.datasetRevisionDigest,
    executionInputDigest: plan.digests.executionInputDigest,
    evaluationInputDigest: plan.digests.evaluationInputDigest,
    analysisInputDigest: plan.digests.analysisInputDigest,
    randomizationDesignDigest: plan.digests.randomizationDesignDigest,
    executionPlanDigest: plan.digests.executionPlanDigest,
    evaluationPlanDigest: plan.digests.evaluationPlanDigest,
    analysisPlanDigest: plan.digests.analysisPlanDigest,
    decisionPlanDigest: plan.digests.decisionPlanDigest,
  });
}

function seriesId(input: Readonly<EvaluationSeriesInput>, base: PreparedEvaluation): string {
  const designDigest = digestCanonicalJson({
    stageDesign: stageDesign(base.plan),
    repeatCount: input.repeatCount,
    stability: {
      sourceAnalysisId: input.stability.sourceAnalysisId,
      projection: input.stability.projection,
      minimumMemberEvidenceStatus:
        input.stability.minimumMemberEvidenceStatus ?? 'complete',
      minimumComparabilityStatus:
        input.stability.minimumComparabilityStatus ?? 'conditional',
    },
    schedulingKind: 'sequential',
  });
  return `${input.seriesInstanceId}-${designDigest.slice('sha256:'.length, 23)}`;
}

function memberRunId(seriesDesignDigest: string, replicateIndex: number): string {
  const digest = digestCanonicalJson({
    derivation: 'omk.eval-runtime.series-member-run-id/v1',
    seriesDesignDigest,
    replicateIndex,
  });
  return `series-member-${replicateIndex}-${digest.slice('sha256:'.length, 23)}`;
}

function seriesArtifactId(seriesDesignDigest: string, artifactKind: string): string {
  const digest = digestCanonicalJson({
    derivation: 'omk.eval-runtime.series-artifact-id/v1',
    seriesDesignDigest,
    artifactKind,
  });
  return `series-${artifactKind}-${digest.slice('sha256:'.length, 31)}`;
}

function assertSourceProjection(
  base: PreparedEvaluation,
  stability: Readonly<EvaluationSeriesStability>,
): void {
  const node = base.definition.analysisGraph.nodes.find((candidate) => (
    candidate.outputResultId === stability.sourceAnalysisId
  ));
  const expectedKind = stability.projection === 'scalar' ? 'reducer' : 'estimator';
  if (node === undefined || node.analysisNodeKind !== expectedKind) {
    fail('Evaluation Series stability projection 与所选 Analysis result 不匹配。');
  }
}

function estimateSeriesWork(
  repeatCount: number,
  perRun: EvaluationWorkEstimate,
): EvaluationSeriesWorkEstimate {
  return Object.freeze({
    repeatCount,
    perRun,
    executionCoordinates: perRun.executionCoordinates * repeatCount,
    evaluationCoordinates: perRun.evaluationCoordinates * repeatCount,
    plannedInvocations: perRun.plannedInvocations * repeatCount,
    uncertain: perRun.uncertain,
  });
}

function assertMemberPlans(
  base: PreparedEvaluation,
  members: readonly PreparedEvaluation[],
  definition: EvaluationSeriesDefinition,
): void {
  const expectedDesign = canonicalizeJson(stageDesign(base.plan));
  const runContracts = new Set<string>();
  for (const [index, member] of members.entries()) {
    const slot = definition.members[index];
    if (slot === undefined
        || canonicalizeJson(stageDesign(member.plan)) !== expectedDesign
        || canonicalizeJson(member.definition.seriesMembership) !== canonicalizeJson({
          seriesDesignDigest: definition.seriesDesignDigest,
          memberId: slot.memberId,
          replicateIndex: slot.replicateIndex,
        })
        || runContracts.has(member.planDigest)) {
      fail('Evaluation Series member plans 未保持同一封存测量设计或唯一 membership。');
    }
    runContracts.add(member.planDigest);
  }
}

async function executePreparedSeries(
  prepared: Readonly<{
    definition: EvaluationSeriesDefinition;
    plan: EvaluationSeriesPlan;
    members: readonly PreparedEvaluation[];
  }>,
  options: Readonly<EvaluationSeriesRunOptions>,
): Promise<EvaluationSeriesResult> {
  const outcomes: EvaluationSeriesMemberResult[] = [];
  const sources: EvaluationSeriesMemberSource[] = [];
  const lineage = new Set<string>();
  let cancelled = false;
  for (const [index, member] of prepared.members.entries()) {
    const slot = prepared.definition.members[index]!;
    const runId = memberRunId(prepared.definition.seriesDesignDigest, slot.replicateIndex);
    const base = {
      memberId: slot.memberId,
      replicateIndex: slot.replicateIndex,
      runId,
      plan: member.plan,
    };
    if (options.signal?.aborted) {
      cancelled = true;
      outcomes.push(Object.freeze({
        ...base,
        memberStatus: 'not-produced',
        admissionStatus: 'not-attempted',
        reasonCode: 'series-member-cancelled-before-start',
      }));
      continue;
    }
    const result = await member.run({
      runId,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
      ...(options.summaries === undefined ? {} : { summaries: options.summaries }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    if (result.status === 'cancelled') cancelled = true;
    let source: EvaluationSeriesMemberSource | undefined;
    try {
      source = createCanonicalEvaluationSeriesMemberSource(result, {
        seriesDesignDigest: prepared.definition.seriesDesignDigest,
        memberId: slot.memberId,
        replicateIndex: slot.replicateIndex,
      });
    } catch {
      source = undefined;
    }
    if (source === undefined) {
      outcomes.push(Object.freeze({
        ...base,
        memberStatus: 'produced',
        admissionStatus: 'rejected',
        reasonCode: 'series-member-source-unavailable',
        result,
      }));
      continue;
    }
    const lineageKey = canonicalizeJson([
      source.reference.executionBundleDigest,
      source.reference.evaluationBundleDigest,
      source.reference.analysisBundleDigest,
    ]);
    if (lineage.has(lineageKey)) {
      outcomes.push(Object.freeze({
        ...base,
        memberStatus: 'produced',
        admissionStatus: 'rejected',
        reasonCode: 'series-member-lineage-duplicate',
        result,
      }));
      continue;
    }
    lineage.add(lineageKey);
    sources.push(source);
    outcomes.push(Object.freeze({
      ...base,
      memberStatus: 'produced',
      admissionStatus: 'admitted',
      result,
    }));
  }

  const runtime = createRunStabilityRuntime();
  const coreResult = await runEvaluationSeries(
    prepared.plan,
    sources,
    {
      analysisNodesByNodeId: new Map([[SERIES_STABILITY_NODE_ID, runtime]]),
      decisionPoliciesByDecisionPolicyId: new Map(),
      schemaValidators: createRunStabilitySchemaValidators(),
      clock: options.clock ?? createNodeEvaluationClock(),
    },
    {
      runId: seriesArtifactId(prepared.definition.seriesDesignDigest, 'run'),
      bundleId: seriesArtifactId(prepared.definition.seriesDesignDigest, 'analysis'),
      reportId: seriesArtifactId(prepared.definition.seriesDesignDigest, 'report'),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  const records = coreResult.analysis?.records ?? [];
  const analysisResults = Object.freeze(Object.fromEntries(
    records.map((record) => [record.resultId, record]),
  ));
  const stability = analysisResults[SERIES_STABILITY_NODE_ID] as
    | EvaluationSeriesStabilityResult
    | undefined;
  const facade = {
    seriesId: prepared.definition.seriesId,
    definition: prepared.definition,
    plan: prepared.plan,
    memberExecutionStatus: cancelled ? 'cancelled' as const : 'completed' as const,
    members: Object.freeze(outcomes),
    analysisResults,
  };
  if (coreResult.status === 'completed') {
    if (stability === undefined) {
      throw new Error('Completed Evaluation Series is missing its stability record.');
    }
    return Object.freeze({ ...coreResult, ...facade, stability });
  }
  return Object.freeze({
    ...coreResult,
    ...facade,
    ...(stability === undefined ? {} : { stability }),
  });
}

/** Seals every fixed-design repeat before the first Target invocation. */
export async function prepareEvaluationSeries(
  input: Readonly<EvaluationSeriesInput>,
): Promise<PreparedEvaluationSeries> {
  const captured = captureSeriesInput(input);
  const template = await prepareEvaluationSeriesTemplate(captured.evaluation);
  if (template.base.policy.cache.executionMode !== 'disabled'
      || template.base.policy.cache.evaluationMode !== 'disabled') {
    fail('Evaluation Series repeatability 不接受 cache-enabled Evaluation policy。');
  }
  assertSourceProjection(template.base, captured.stability);
  const id = seriesId(captured, template.base);
  const members = Array.from({ length: captured.repeatCount }, (_, replicateIndex) => ({
    memberId: `member-${replicateIndex}`,
    replicateIndex,
  }));
  const runtime = createRunStabilityRuntime();
  const definition = createEvaluationSeriesDefinition({
    schemaVersion: EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION,
    seriesId: id,
    analysisMode: 'preregistered',
    experimentalUnit: 'run',
    members,
    comparabilityPolicy: {
      designMode: 'exact-measurement-design',
      comparisonScope: 'analysis',
      minimumStatus: captured.stability.minimumComparabilityStatus ?? 'conditional',
    },
    analysisGraph: {
      nodes: [{
        nodeId: SERIES_STABILITY_NODE_ID,
        implementationId: runtime.identity.implementationId,
        analysisStandardId: runtime.identity.implementationId,
        minimumMemberEvidenceStatus:
          captured.stability.minimumMemberEvidenceStatus ?? 'complete',
        inputs: [{ seriesInputKind: 'members', referenceId: id }],
        outputResultId: SERIES_STABILITY_NODE_ID,
        parameters: {
          sourceAnalysisResultId: captured.stability.sourceAnalysisId,
          projection: captured.stability.projection,
          coverageMode: 'complete-plan',
        },
      }],
    },
    extensions: {
      [SERIES_SCHEDULING_EXTENSION_URI]: {
        schemaUri: SERIES_SCHEDULING_EXTENSION_URI,
        schemaDigest: SERIES_SCHEDULING_SCHEMA_DIGEST,
        data: {
          seriesInstanceId: captured.seriesInstanceId,
          schedulingKind: 'sequential',
          cachePolicy: 'disabled',
          inferenceKind: 'descriptive-fixed-design-repeatability',
        },
      },
    },
  });
  const memberships = definition.members.map(({ memberId, replicateIndex }) => ({
    seriesDesignDigest: definition.seriesDesignDigest,
    memberId,
    replicateIndex,
  }));
  const preparedMembers = await template.prepareMembers(memberships);
  assertMemberPlans(template.base, preparedMembers, definition);
  const plan = prepareEvaluationSeriesPlan(definition, [{
    runtimeKind: 'series-analysis-node',
    referenceId: SERIES_STABILITY_NODE_ID,
    identity: runtime.identity,
    outputSchema: runtime.outputSchema,
  }]);
  let consumed = false;
  return Object.freeze({
    seriesId: definition.seriesId,
    definition,
    plan,
    memberPlans: Object.freeze(preparedMembers.map((member) => member.plan)),
    estimatedWork: estimateSeriesWork(captured.repeatCount, template.base.estimatedWork),
    run(options?: Readonly<EvaluationSeriesRunOptions>) {
      if (consumed) fail('Prepared Evaluation Series 只能运行一次。');
      const capturedOptions = assertSeriesOptions(options);
      consumed = true;
      return executePreparedSeries(
        { definition, plan, members: preparedMembers },
        capturedOptions,
      );
    },
  });
}

/** Runs one preregistered fixed-design repeatability Series. */
export async function evaluateSeries(
  input: Readonly<EvaluationSeriesInput>,
  options?: Readonly<EvaluationSeriesRunOptions>,
): Promise<EvaluationSeriesResult> {
  const prepared = await prepareEvaluationSeries(input);
  return prepared.run(options);
}
