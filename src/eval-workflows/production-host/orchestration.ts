import {
  canonicalizeJson,
  createEvaluationSeriesMemberSource,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  effectiveAnalysisBundleTrust,
  effectiveEvaluationBundleTrust,
  effectiveExecutionBundleTrust,
  prepareEvaluationSeriesPlan,
  verifyAnalysisBundle,
  verifyDecisionResult,
  verifyEvaluationBundle,
  verifyExecutionBundle,
  IdentifierSchema,
  TimestampSchema,
  type CoreSchemaValidator,
  type EvaluationSeriesMembership,
  type EvaluationSeriesPlan,
  type JsonValue,
  type Sha256Digest,
} from '../../eval-core/contracts/index.js';
import type { SealedRunPlan } from '../../eval-core/compiler/index.js';
import {
  runEvaluationSeries,
  type EvaluationSeriesRunResult,
} from '../../eval-core/series/index.js';
import {
  type CoreBatchArtifactStore,
  type StoredCoreBatch,
  type StoredCoreRunArtifacts,
} from '../artifact-store/index.js';
import type { CoreResumeVerificationContexts } from '../resume-admission/index.js';
import {
  createOmkEvaluationRuntime,
  createOmkEvaluationSchemaValidators,
  type OmkEvaluationPreflightOptions,
  type OmkEvaluationRuntime,
} from '../runtime-adapter/index.js';
import {
  projectCoreEvolutionEvidence,
} from '../projections/evolution.js';
import type { CoreEvolutionEvidence } from '../projections/contracts.js';
import {
  bindProductionPreparedEvaluation,
  ProductionEvaluationHostError,
  type ProductionEvaluationExecuteOptions,
  type ProductionEvaluationHostInput,
  type ProductionEvaluationRun,
  type ProductionPreparedEvaluation,
} from './workflow.js';

export interface ProductionBatchChildInput {
  readonly itemId: string;
  readonly prepared: ProductionPreparedEvaluation;
  readonly options: ProductionEvaluationExecuteOptions;
}

export type ProductionBatchPersistence = {
  readonly persistenceStatus: 'stored';
  readonly batch: StoredCoreBatch;
} | {
  readonly persistenceStatus: 'skipped';
  readonly reasonCode: 'BATCH_CHILD_ARTIFACTS_INCOMPLETE';
  readonly childRunIds: readonly string[];
} | {
  readonly persistenceStatus: 'failed';
  readonly error: ProductionEvaluationHostError;
};

export interface ProductionBatchRun {
  readonly batchId: string;
  readonly children: readonly ({
    readonly itemId: string;
    readonly runId: string;
    readonly executionStatus: 'started';
    readonly run: ProductionEvaluationRun;
  } | {
    readonly itemId: string;
    readonly runId: string;
    readonly executionStatus: 'start-failed';
    readonly error: ProductionEvaluationHostError;
  })[];
  /** Resolves only after every child publication settles; no Core batch report is created. */
  readonly persistence: Promise<ProductionBatchPersistence>;
}

function validUniqueBatchChildren(children: readonly ProductionBatchChildInput[]): boolean {
  return children.length > 0
    && children.every(({ itemId, options }) => (
      IdentifierSchema.safeParse(itemId).success
      && IdentifierSchema.safeParse(options.runId).success
      && TimestampSchema.safeParse(options.createdAt).success
    ))
    && new Set(children.map(({ itemId }) => itemId)).size === children.length
    && new Set(children.map(({ options }) => options.runId)).size === children.length;
}

/** Executes independent child runs and publishes only a locator-only Batch manifest. */
export async function executeProductionEvaluationBatch(input: Readonly<{
  batchId: string;
  createdAt: string;
  children: readonly ProductionBatchChildInput[];
  batchStore: CoreBatchArtifactStore;
}>): Promise<ProductionBatchRun> {
  if (!IdentifierSchema.safeParse(input.batchId).success
      || !TimestampSchema.safeParse(input.createdAt).success
      || !validUniqueBatchChildren(input.children)
      || input.batchStore === null
      || typeof input.batchStore !== 'object'
      || typeof input.batchStore.save !== 'function') {
    throw new ProductionEvaluationHostError({
      code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID',
      fieldPath: 'batch',
      message: 'Batch child identity 或 artifact store 不合法。',
    });
  }
  const saveBatch = input.batchStore.save.bind(input.batchStore);
  const children = await Promise.all(input.children.map(async (child) => {
    try {
      return Object.freeze({
        itemId: child.itemId,
        runId: child.options.runId,
        executionStatus: 'started' as const,
        run: await child.prepared.execute(child.options),
      });
    } catch (cause) {
      return Object.freeze({
        itemId: child.itemId,
        runId: child.options.runId,
        executionStatus: 'start-failed' as const,
        error: new ProductionEvaluationHostError({
          code: 'PRODUCTION_EVALUATION_BATCH_CHILD_START_FAILED',
          runId: child.options.runId,
          message: 'Evaluation Core Batch child 启动失败。',
          cause,
        }),
      });
    }
  }));
  const persistence = Promise.all(children.map(async (child) => ({
    runId: child.runId,
    outcome: child.executionStatus === 'started'
      ? await child.run.persistence
      : undefined,
  }))).then(async (outcomes): Promise<ProductionBatchPersistence> => {
    const incomplete = outcomes.filter(({ outcome }) => (
      outcome?.persistenceStatus !== 'stored'
    )).map(({ runId }) => runId);
    if (incomplete.length > 0) return Object.freeze({
      persistenceStatus: 'skipped',
      reasonCode: 'BATCH_CHILD_ARTIFACTS_INCOMPLETE',
      childRunIds: Object.freeze(incomplete),
    });
    try {
      const batch = await saveBatch({
        batchId: input.batchId,
        createdAt: input.createdAt,
        children: children.map(({ itemId, runId }) => ({ itemId, runId })),
      });
      return Object.freeze({ persistenceStatus: 'stored', batch });
    } catch (cause) {
      return Object.freeze({
        persistenceStatus: 'failed',
        error: new ProductionEvaluationHostError({
          code: 'PRODUCTION_EVALUATION_BATCH_PERSIST_FAILED',
          message: 'Evaluation Core Batch manifest 原子持久化失败。',
          cause,
        }),
      });
    }
  });
  return Object.freeze({
    batchId: input.batchId,
    children: Object.freeze(children),
    persistence,
  });
}

export interface ProductionSeriesMemberOptions extends ProductionEvaluationExecuteOptions {
  /** Optional independent cache／budget attestations for persisted evidence. */
  readonly verification?: CoreResumeVerificationContexts;
}

export interface ProductionEvaluationSeriesRun {
  readonly plan: EvaluationSeriesPlan;
  readonly members: readonly ({
    readonly membership: EvaluationSeriesMembership;
    readonly prepared: ProductionPreparedEvaluation;
    readonly executionStatus: 'started';
    readonly run: ProductionEvaluationRun;
  } | {
    readonly membership: EvaluationSeriesMembership;
    readonly prepared: ProductionPreparedEvaluation;
    readonly executionStatus: 'start-failed';
    readonly error: ProductionEvaluationHostError;
  })[];
  readonly result: Promise<EvaluationSeriesRunResult>;
  readonly evolution: Promise<CoreEvolutionEvidence | undefined>;
}

function memberCompiled(
  input: ProductionEvaluationHostInput['compiled'],
  membership: EvaluationSeriesMembership,
): ProductionEvaluationHostInput['compiled'] {
  const snapshot = structuredClone(input);
  const definition = { ...snapshot.definition, seriesMembership: membership };
  return deepFreezeCanonicalJson(
    {
      ...snapshot,
      definition,
      canonicalDigests: {
        ...snapshot.canonicalDigests,
        definition: digestCanonicalJson(definition),
      },
    } as unknown as JsonValue,
  ) as unknown as ProductionEvaluationHostInput['compiled'];
}

function attestationSet(
  digest: Sha256Digest,
  supplied: ReadonlySet<Sha256Digest> | undefined,
): ReadonlySet<Sha256Digest> {
  return new Set([...(supplied ?? []), digest]);
}

function seriesMemberSource(input: {
  membership: EvaluationSeriesMembership;
  plan: SealedRunPlan;
  artifacts: StoredCoreRunArtifacts;
  validators: ReadonlyMap<string, CoreSchemaValidator>;
  verification?: CoreResumeVerificationContexts;
}) {
  const { artifacts, verification } = input;
  const execution = verifyExecutionBundle(artifacts.execution, input.plan, {
    ...verification?.execution,
    verifiedProvenanceBundleDigests: attestationSet(
      artifacts.execution.bundleDigest as Sha256Digest,
      verification?.execution?.verifiedProvenanceBundleDigests,
    ),
  });
  const evaluation = verifyEvaluationBundle(
    artifacts.evaluation,
    input.plan,
    execution,
    {
      ...verification?.evaluation,
      verifiedProvenanceBundleDigests: attestationSet(
        artifacts.evaluation.bundleDigest as Sha256Digest,
        verification?.evaluation?.verifiedProvenanceBundleDigests,
      ),
      executionSourceTrust: verification?.evaluation?.executionSourceTrust
        ?? effectiveExecutionBundleTrust(execution),
    },
  );
  const analysis = verifyAnalysisBundle(
    artifacts.analysis,
    input.plan,
    execution,
    evaluation,
    { schemaValidators: input.validators },
    {
      ...verification?.analysis,
      verifiedProvenanceBundleDigests: attestationSet(
        artifacts.analysis.bundleDigest as Sha256Digest,
        verification?.analysis?.verifiedProvenanceBundleDigests,
      ),
      evaluationSourceTrust: verification?.analysis?.evaluationSourceTrust
        ?? effectiveEvaluationBundleTrust(evaluation),
    },
  );
  const decision = artifacts.report.decision === undefined
    ? undefined
    : verifyDecisionResult(
      artifacts.report.decision,
      input.plan,
      execution,
      evaluation,
      analysis,
      {
        ...verification?.decision,
        verifiedPolicyExecutionDigests: attestationSet(
          artifacts.report.decision.decisionDigest as Sha256Digest,
          verification?.decision?.verifiedPolicyExecutionDigests,
        ),
        analysisSourceTrust: verification?.decision?.analysisSourceTrust
          ?? effectiveAnalysisBundleTrust(analysis),
      },
    );
  return createEvaluationSeriesMemberSource({
    ...input.membership,
    plan: input.plan,
    execution,
    evaluation,
    analysis,
    ...(decision === undefined ? {} : { decision }),
    report: artifacts.report,
  });
}

async function prepareSeriesMember(input: {
  host: ProductionEvaluationHostInput;
  membership: EvaluationSeriesMembership;
  preflight?: Readonly<OmkEvaluationPreflightOptions>;
  validators: ReadonlyMap<string, CoreSchemaValidator>;
}): Promise<{
  runtime: OmkEvaluationRuntime;
  prepared: ProductionPreparedEvaluation;
}> {
  const createRuntime = input.host.createRuntime ?? createOmkEvaluationRuntime;
  const runtime = await createRuntime({
    compiled: memberCompiled(input.host.compiled, input.membership),
    factories: input.host.factories,
    support: input.host.support,
    resources: input.host.resources,
  });
  const platformPrepared = await runtime.prepare(input.preflight);
  return {
    runtime,
    prepared: bindProductionPreparedEvaluation({
      prepared: platformPrepared,
      artifactStore: input.host.artifactStore,
      schemaValidators: input.validators,
    }),
  };
}

/** Runs preregistered independent repeats as run-level Series members. */
export async function executeProductionEvaluationSeries(input: Readonly<{
  host: ProductionEvaluationHostInput;
  members: readonly ProductionSeriesMemberOptions[];
  bundleId: string;
  reportId: string;
  seriesSignal?: AbortSignal;
  preflight?: Readonly<OmkEvaluationPreflightOptions>;
}>): Promise<ProductionEvaluationSeriesRun> {
  const series = input.host.compiled.orchestration.independentSeries;
  if (series === undefined
      || input.host.compiled.orchestration.dryRun
      || input.members.length !== series.memberships.length
      || new Set(input.members.map(({ runId }) => runId)).size !== input.members.length
      || !IdentifierSchema.safeParse(input.bundleId).success
      || !IdentifierSchema.safeParse(input.reportId).success
      || input.members.some(({ runId, createdAt }) => (
        !IdentifierSchema.safeParse(runId).success
        || !TimestampSchema.safeParse(createdAt).success
      ))) {
    throw new ProductionEvaluationHostError({
      code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID',
      fieldPath: 'series.members',
      message: 'Independent Series member options 与预注册 slot 不一致。',
    });
  }
  const validators = createOmkEvaluationSchemaValidators(
    input.host.support.schemaValidators,
  );
  const preparedMembers = await Promise.all(series.memberships.map(async (membership) => (
    prepareSeriesMember({
      host: input.host,
      membership,
      validators,
      ...(input.preflight === undefined ? {} : { preflight: input.preflight }),
    })
  )));
  const seriesAssembly = preparedMembers[0]?.runtime.series;
  if (seriesAssembly === undefined
      || preparedMembers.some(({ runtime }) => runtime.series === undefined
        || canonicalizeJson(runtime.series.runtimes)
          !== canonicalizeJson(seriesAssembly.runtimes))) {
    throw new ProductionEvaluationHostError({
      code: 'PRODUCTION_EVALUATION_SERIES_SOURCE_INVALID',
      message: 'Independent Series Runtime binding 缺失或跨 member 不一致。',
    });
  }
  const plan = prepareEvaluationSeriesPlan(series.definition, seriesAssembly.runtimes);
  const members = await Promise.all(preparedMembers.map(async ({ prepared }, index) => {
    const membership = series.memberships[index]!;
    try {
      return Object.freeze({
        membership,
        prepared,
        executionStatus: 'started' as const,
        run: await prepared.execute(input.members[index]!),
      });
    } catch (cause) {
      return Object.freeze({
        membership,
        prepared,
        executionStatus: 'start-failed' as const,
        error: new ProductionEvaluationHostError({
          code: 'PRODUCTION_EVALUATION_SERIES_MEMBER_START_FAILED',
          runId: input.members[index]!.runId,
          message: 'Independent Series member 启动失败。',
          cause,
        }),
      });
    }
  }));
  const result = Promise.all(members.map(async (member, index) => ({
    membership: member.membership,
    plan: member.prepared.plan,
    verification: input.members[index]?.verification,
    persistence: member.executionStatus === 'started'
      ? await member.run.persistence
      : undefined,
  }))).then(async (outcomes) => {
    const sources = outcomes.flatMap(({ membership, plan: memberPlan, persistence, verification }) => {
      if (persistence?.persistenceStatus !== 'stored') return [];
      try {
        return [seriesMemberSource({
          membership,
          plan: memberPlan,
          artifacts: persistence.artifacts,
          validators,
          ...(verification === undefined ? {} : { verification }),
        })];
      } catch (cause) {
        throw new ProductionEvaluationHostError({
          code: 'PRODUCTION_EVALUATION_SERIES_SOURCE_INVALID',
          runId: persistence.artifacts.manifest.runId,
          message: 'Persisted Core run 无法验证为 Series member source。',
          cause,
        });
      }
    });
    return runEvaluationSeries(plan, sources, {
      ...seriesAssembly.ports,
      schemaValidators: validators,
      clock: input.host.support.clock,
    }, {
      runId: input.reportId,
      bundleId: input.bundleId,
      reportId: input.reportId,
      ...(input.seriesSignal === undefined ? {} : { signal: input.seriesSignal }),
    });
  });
  const evolution = result.then((seriesResult) => (
    seriesResult.status === 'completed'
      ? projectCoreEvolutionEvidence({
        plan,
        analysis: seriesResult.analysis,
        report: seriesResult.report,
      })
      : undefined
  ));
  return Object.freeze({
    plan,
    members: Object.freeze(members),
    result,
    evolution,
  });
}

/** Exact delegates for post-persistence consumers; no legacy row interpretation. */
export { compareGoldToCoreRun } from '../projections/gold.js';
export { projectCoreArtifactGraph } from '../projections/artifact-graph.js';
