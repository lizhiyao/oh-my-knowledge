import {
  createEvaluationSeriesMemberSource,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  effectiveAnalysisBundleTrust,
  effectiveEvaluationBundleTrust,
  effectiveExecutionBundleTrust,
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
  type EvaluationSeriesRunResult,
} from '../../eval-core/series/index.js';
import {
  type StoredCoreRunArtifacts,
} from '../artifact-store/index.js';
import type { CoreResumeVerificationContexts } from '../resume-admission/index.js';
import type { EvaluationPreparationOptions as OmkEvaluationPreflightOptions } from '../../eval-runtime/provider.js';
import {
  projectCoreEvolutionEvidence,
} from '../projections/evolution.js';
import type { CoreEvolutionEvidence } from '../projections/contracts.js';
import {
  bindProductionPreparedEvaluation,
  evaluationExecutionInput,
  ProductionEvaluationHostError,
  type ProductionEvaluationExecuteOptions,
  type ProductionEvaluationWorkflowInput,
  type ProductionEvaluationRun,
  type ProductionPreparedEvaluation,
} from './workflow.js';

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
  input: ProductionEvaluationWorkflowInput['compiled'],
  membership: EvaluationSeriesMembership,
): ProductionEvaluationWorkflowInput['compiled'] {
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
  ) as unknown as ProductionEvaluationWorkflowInput['compiled'];
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
  host: ProductionEvaluationWorkflowInput;
  membership: EvaluationSeriesMembership;
  preflight?: Readonly<OmkEvaluationPreflightOptions>;
  validators: ReadonlyMap<string, CoreSchemaValidator>;
}): Promise<ProductionPreparedEvaluation> {
  return bindProductionPreparedEvaluation({
    prepared: await input.host.runtime.prepare(
      evaluationExecutionInput(memberCompiled(input.host.compiled, input.membership)), input.preflight,
    ),
    artifactStore: input.host.artifactStore,
    schemaValidators: input.validators,
  });
}

/** Runs preregistered independent repeats as run-level Series members. */
export async function executeProductionEvaluationSeries(input: Readonly<{
  host: ProductionEvaluationWorkflowInput;
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
  const validators = new Map(input.host.schemaValidators);
  const preparedMembers = await Promise.all(series.memberships.map(async (membership) => (
    prepareSeriesMember({
      host: input.host,
      membership,
      validators,
      ...(input.preflight === undefined ? {} : { preflight: input.preflight }),
    })
  )));
  const preparedSeries = await input.host.runtime.prepareSeries(series.definition);
  const plan = preparedSeries.plan;
  const members = await Promise.all(preparedMembers.map(async (prepared, index) => {
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
  const result = Promise.all(members.map(async (member, index) => {
    if (member.executionStatus !== 'started') return {
      membership: member.membership, plan: member.prepared.plan,
      verification: input.members[index]?.verification,
      persistence: undefined,
    };
    const [runtimeOutcome, persistence] = await Promise.all([
      member.run.result.then(() => ({ succeeded: true as const }), (cause: unknown) => ({
        succeeded: false as const, cause,
      })),
      member.run.persistence,
    ]);
    return {
      membership: member.membership, plan: member.prepared.plan,
      verification: input.members[index]?.verification, persistence, runtimeOutcome,
    };
  })).then(async (outcomes) => {
    for (const outcome of outcomes) {
      if (outcome.runtimeOutcome?.succeeded === false) throw new ProductionEvaluationHostError({
        code: 'PRODUCTION_EVALUATION_SERIES_MEMBER_RUNTIME_FAILED',
        message: 'Series member 的运行环境失败；已保存的测量证据不能授权本次发布。',
        cause: outcome.runtimeOutcome.cause,
      });
    }
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
    return preparedSeries.run(sources, {
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
  // Each outcome remains awaitable; consuming one must not require consuming its sibling.
  void result.catch(() => {});
  void evolution.catch(() => {});
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
