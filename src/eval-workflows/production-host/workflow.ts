import {
  TimestampSchema,
  type CoreSchemaValidator,
} from '../../evaluation-core/contracts/index.js';
import {
  assertSealedRunPlan,
  type SealedRunPlan,
} from '../../evaluation-core/compiler/index.js';
import type {
  EvaluationRun,
  EvaluationRunResult,
} from '../../evaluation-core/engine/index.js';
import type { CliEvaluationCompileResult } from '../input-compilation/index.js';
import {
  type CoreRunArtifactStore,
  type SaveCoreRunArtifactsRequest,
  type StoredCoreRunArtifacts,
} from '../artifact-store/index.js';
import {
  createCoreResumeAdmissionAdapter,
  type CoreResumeAdmissionRequest,
  type CoreResumeAdmissionResult,
} from '../resume-admission/index.js';
import {
  createOmkEvaluationRuntime,
  createOmkEvaluationSchemaValidators,
  type CreateOmkEvaluationRuntimeInput,
  type OmkEvaluationPreflightOptions,
  type OmkEvaluationPreflightResult,
  type OmkEvaluationRunOptions,
  type OmkEvaluationRuntime,
  type OmkRuntimeBindingFactories,
} from '../runtime-adapter/index.js';

type RuntimeFactory = (
  input: Readonly<CreateOmkEvaluationRuntimeInput>,
) => Promise<OmkEvaluationRuntime>;

type PersistableArtifacts = Pick<
  SaveCoreRunArtifactsRequest,
  'execution' | 'evaluation' | 'analysis' | 'report'
>;

export interface ProductionEvaluationHostInput {
  readonly compiled: CliEvaluationCompileResult;
  readonly factories: OmkRuntimeBindingFactories;
  readonly support: CreateOmkEvaluationRuntimeInput['support'];
  readonly resources: CreateOmkEvaluationRuntimeInput['resources'];
  readonly artifactStore: CoreRunArtifactStore;
  /** Alternate platform composition seam; production defaults to the OMK Runtime. */
  readonly createRuntime?: RuntimeFactory;
}

export interface ProductionEvaluationExecuteOptions extends OmkEvaluationRunOptions {
  /** Caller-owned publication timestamp; never derived inside Core. */
  readonly createdAt: string;
}

export type ProductionArtifactPersistence = {
  readonly persistenceStatus: 'stored';
  readonly artifacts: StoredCoreRunArtifacts;
} | {
  readonly persistenceStatus: 'skipped';
  readonly reasonCode:
    | 'CORE_RESULT_INCOMPLETE'
    | 'CORE_RESULT_UNAVAILABLE';
} | {
  readonly persistenceStatus: 'failed';
  readonly error: ProductionEvaluationHostError;
};

export interface ProductionEvaluationRun {
  /** Lossy, bounded observability stream; consumption is never authoritative. */
  readonly events: EvaluationRun['events'];
  /** The exact Core promise and result, without status or score rewriting. */
  readonly result: Promise<EvaluationRunResult>;
  /** Non-throwing publication outcome, evaluated independently from Core status. */
  readonly persistence: Promise<ProductionArtifactPersistence>;
}

export interface ProductionPreparedEvaluation {
  readonly executionMode: 'dry-run' | 'execute';
  readonly plan: SealedRunPlan;
  readonly preflight: OmkEvaluationPreflightResult;
  execute(
    options: Readonly<ProductionEvaluationExecuteOptions>,
  ): Promise<ProductionEvaluationRun>;
  admitResume(
    request: Readonly<Omit<CoreResumeAdmissionRequest, 'plan'>>,
  ): Promise<CoreResumeAdmissionResult>;
}

export interface ProductionEvaluationHost {
  prepare(
    options?: Readonly<OmkEvaluationPreflightOptions>,
  ): Promise<ProductionPreparedEvaluation>;
}

export type ProductionEvaluationHostErrorCode =
  | 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID'
  | 'PRODUCTION_EVALUATION_DRY_RUN_EXECUTION_FORBIDDEN'
  | 'PRODUCTION_EVALUATION_ARTIFACT_PERSIST_FAILED'
  | 'PRODUCTION_EVALUATION_BATCH_PERSIST_FAILED'
  | 'PRODUCTION_EVALUATION_BATCH_CHILD_START_FAILED'
  | 'PRODUCTION_EVALUATION_SERIES_MEMBER_START_FAILED'
  | 'PRODUCTION_EVALUATION_SERIES_SOURCE_INVALID'
  | 'PRODUCTION_EVALUATION_SERIES_RUN_INCOMPLETE';

export class ProductionEvaluationHostError extends Error {
  readonly code: ProductionEvaluationHostErrorCode;
  readonly fieldPath?: string;
  readonly runId?: string;

  constructor(input: {
    code: ProductionEvaluationHostErrorCode;
    message: string;
    fieldPath?: string;
    runId?: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'ProductionEvaluationHostError';
    this.code = input.code;
    this.fieldPath = input.fieldPath;
    this.runId = input.runId;
  }
}

function fail(
  input: ConstructorParameters<typeof ProductionEvaluationHostError>[0],
): never {
  throw new ProductionEvaluationHostError(input);
}

function captureArtifactStore(store: CoreRunArtifactStore): CoreRunArtifactStore {
  if (store === null || typeof store !== 'object'
      || typeof store.save !== 'function'
      || typeof store.get !== 'function'
      || typeof store.inspect !== 'function'
      || typeof store.list !== 'function'
      || typeof store.exists !== 'function') fail({
    code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID',
    fieldPath: 'artifactStore',
    message: 'Core artifact store 不符合生产宿主 contract。',
  });
  return Object.freeze({
    save: store.save.bind(store),
    get: store.get.bind(store),
    inspect: store.inspect.bind(store),
    list: store.list.bind(store),
    exists: store.exists.bind(store),
  });
}

function persistableArtifacts(
  result: Readonly<EvaluationRunResult>,
): PersistableArtifacts | undefined {
  const artifacts = result.artifacts;
  if (artifacts?.execution === undefined
      || artifacts.evaluation === undefined
      || artifacts.analysis === undefined
      || result.report === undefined) return undefined;
  return {
    execution: artifacts.execution,
    evaluation: artifacts.evaluation,
    analysis: artifacts.analysis,
    report: result.report,
  };
}

async function persistResult(input: {
  readonly store: CoreRunArtifactStore;
  readonly plan: SealedRunPlan;
  readonly runId: string;
  readonly createdAt: string;
  readonly result: Readonly<EvaluationRunResult>;
}): Promise<ProductionArtifactPersistence> {
  const artifacts = persistableArtifacts(input.result);
  if (artifacts === undefined) return Object.freeze({
    persistenceStatus: 'skipped',
    reasonCode: 'CORE_RESULT_INCOMPLETE',
  });
  try {
    const stored = await input.store.save({
      runId: input.runId,
      createdAt: input.createdAt,
      plan: input.plan,
      ...artifacts,
    });
    return Object.freeze({ persistenceStatus: 'stored', artifacts: stored });
  } catch (cause) {
    return Object.freeze({
      persistenceStatus: 'failed',
      error: new ProductionEvaluationHostError({
        code: 'PRODUCTION_EVALUATION_ARTIFACT_PERSIST_FAILED',
        runId: input.runId,
        message: 'Evaluation Core 五件套原子持久化失败。',
        cause,
      }),
    });
  }
}

export interface BindProductionPreparedEvaluationInput {
  readonly prepared: Awaited<ReturnType<OmkEvaluationRuntime['prepare']>>;
  readonly artifactStore: CoreRunArtifactStore;
  readonly schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
  readonly executionMode?: 'dry-run' | 'execute';
}

/** Binds an already prepared platform Runtime to the production host policy. */
export function bindProductionPreparedEvaluation(
  input: Readonly<BindProductionPreparedEvaluationInput>,
): ProductionPreparedEvaluation {
  if (input.executionMode !== undefined
      && input.executionMode !== 'dry-run'
      && input.executionMode !== 'execute') fail({
    code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID',
    fieldPath: 'executionMode',
    message: 'Production preparation execution mode 不合法。',
  });
  try {
    assertSealedRunPlan(input.prepared.plan);
  } catch (cause) {
    return fail({
      code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID',
      fieldPath: 'prepared.plan',
      message: 'Production preparation 缺少可信 sealed Plan。',
      cause,
    });
  }
  if (!Array.isArray(input.prepared.preflight?.records)
      || typeof input.prepared.start !== 'function') fail({
    code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID',
    fieldPath: 'prepared',
    message: 'Prepared Runtime 不符合生产宿主 contract。',
  });
  const artifactStore = captureArtifactStore(input.artifactStore);
  const plan = input.prepared.plan;
  const preflight = Object.freeze({
    records: Object.freeze(input.prepared.preflight.records.map((record) => (
      Object.freeze({ ...record })
    ))),
  });
  const start = input.prepared.start.bind(input.prepared);
  let schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
  try {
    schemaValidators = new Map(input.schemaValidators);
  } catch (cause) {
    return fail({
      code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID',
      fieldPath: 'schemaValidators',
      message: 'Production SchemaValidator registry 无法建立快照。',
      cause,
    });
  }
  const admission = createCoreResumeAdmissionAdapter({
    artifactStore,
    schemaValidators,
  });
  return Object.freeze({
    executionMode: input.executionMode ?? 'execute',
    plan,
    preflight,
    async execute(
      options: Readonly<ProductionEvaluationExecuteOptions>,
    ): Promise<ProductionEvaluationRun> {
      if (input.executionMode === 'dry-run') fail({
        code: 'PRODUCTION_EVALUATION_DRY_RUN_EXECUTION_FORBIDDEN',
        fieldPath: 'execute',
        message: 'Dry-run preparation 只返回 sealed Plan 与 preflight，不允许启动 Runtime。',
      });
      if (!TimestampSchema.safeParse(options?.createdAt).success) fail({
        code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID',
        fieldPath: 'execute.createdAt',
        message: 'Core artifact publication timestamp 不合法。',
      });
      const { createdAt, ...runOptions } = options;
      const coreRun = await start(runOptions);
      const result = coreRun.result;
      const persistence = result.then(
        (value) => persistResult({
          store: artifactStore,
          plan,
          runId: options.runId,
          createdAt,
          result: value,
        }),
        () => Object.freeze({
          persistenceStatus: 'skipped' as const,
          reasonCode: 'CORE_RESULT_UNAVAILABLE' as const,
        }),
      );
      return Object.freeze({ events: coreRun.events, result, persistence });
    },
    admitResume(
      request: Readonly<Omit<CoreResumeAdmissionRequest, 'plan'>>,
    ): Promise<CoreResumeAdmissionResult> {
      return admission.admit({ ...request, plan });
    },
  });
}

/**
 * Creates the single production boundary around compile output, Runtime
 * preparation, Core execution, resume admission, and atomic publication.
 */
export function createProductionEvaluationHost(
  input: Readonly<ProductionEvaluationHostInput>,
): ProductionEvaluationHost {
  const artifactStore = captureArtifactStore(input.artifactStore);
  const createRuntime = input.createRuntime ?? createOmkEvaluationRuntime;
  if (typeof createRuntime !== 'function') fail({
    code: 'PRODUCTION_EVALUATION_HOST_INPUT_INVALID',
    fieldPath: 'createRuntime',
    message: 'Evaluation Runtime factory 不合法。',
  });
  const schemaValidators = createOmkEvaluationSchemaValidators(
    input.support?.schemaValidators,
  );
  return Object.freeze({
    async prepare(
      options?: Readonly<OmkEvaluationPreflightOptions>,
    ): Promise<ProductionPreparedEvaluation> {
      const runtime = await createRuntime({
        compiled: input.compiled,
        factories: input.factories,
        support: input.support,
        resources: input.resources,
      });
      const prepared = await runtime.prepare(options);
      return bindProductionPreparedEvaluation({
        prepared,
        artifactStore,
        schemaValidators,
        executionMode: input.compiled.orchestration.dryRun ? 'dry-run' : 'execute',
      });
    },
  });
}
