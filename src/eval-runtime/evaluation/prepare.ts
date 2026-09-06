import {
  type Variant,
  type Evaluator,
  type Comparison,
  type Experiment,
  type AnalysisRequest,
  type Decision,
  type Policy,
  type EvaluationRunOptions,
  type RuntimeCapabilityResolution,
  type EvaluationWorkEstimate,
  type EvaluationResult,
  type EvaluateInput,
  type PreparedEvaluation,
} from './contracts.js';
import {
  type EvaluationInfrastructure,
  type ExecutorIdentityVerifier,
  promoteVerifiedExecutorIdentity,
  captureEvaluationInfrastructure,
} from '../infrastructure.js';
import {
  ExperimentSchema,
  AnalysesInputSchema,
  DecisionInputSchema,
  ComparisonInputSchema,
  PolicyInputSchema,
} from './schemas.js';
import {
  z,
} from 'zod';
import {
  configurationFailure,
  EvaluationEventConsumptionError,
  EvaluationConfigurationError,
} from './errors.js';
import {
  IdentifierSchema,
  JsonValueSchema,
  deepFreezeCanonicalJson,
  canonicalizeJson,
  derivePlannedExecutionCoordinates,
  type EvaluationDefinition,
  type EvaluationSeriesMembership,
  EvaluationDefinitionSchema,
} from '../../eval-core/contracts/index.js';
import {
  type SealedRunPlan,
  EvaluationDefinitionError,
} from '../../eval-core/compiler/index.js';
import {
  compareStrings,
} from './ordering.js';
import {
  createMeasurementPolicy,
} from '../builders/policy.js';
import {
  type CapturedVariant,
  captureDataset,
  captureVariant,
} from './capture-input.js';
import {
  type EvaluationRuntimeSupportPorts,
  createEvaluationRuntime,
  EvaluationRuntimeAssemblyError,
} from '../runtime.js';
import {
  type PreparedEvaluation as CorePreparedEvaluation,
  createEvaluationEngine as createCoreEvaluationEngine,
} from '../../eval-core/engine/index.js';
import {
  randomUUID,
} from 'node:crypto';
import {
  runPreparedEvaluation,
  EvaluationEventConsumptionError as AdvancedEvaluationEventConsumptionError,
} from '../runner.js';
import {
  attachDefinition,
  corePreparedEvaluations,
} from './result-state.js';
import {
  captureEvaluators,
} from './capture-evaluators.js';
import {
  createGeneralDefinition,
} from './definition.js';

function assertEvaluateInput(input: Readonly<{
  variants: readonly Variant[];
  evaluators: readonly Evaluator[];
  comparisons: readonly Comparison[];
  experiment: Experiment;
  analyses: readonly AnalysisRequest[];
  decision?: Decision;
  policy: Policy;
  infrastructure?: EvaluationInfrastructure;
}>) {
  const allowedKeys = new Set([
    'dataset',
    'variants',
    'evaluators',
    'comparisons',
    'analyses',
    'decision',
    'experiment',
    'policy',
    'infrastructure',
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))
      || !Array.isArray(input.variants) || input.variants.length === 0
      || !Array.isArray(input.evaluators) || input.evaluators.length === 0
      || !Array.isArray(input.comparisons)
      || !ExperimentSchema.safeParse(input.experiment).success
      || !AnalysesInputSchema.safeParse(input.analyses).success
      || (input.decision !== undefined && !DecisionInputSchema.safeParse(input.decision).success)
      || !z.array(ComparisonInputSchema).safeParse(input.comparisons).success
      || !PolicyInputSchema.safeParse(input.policy).success
      || (input.infrastructure !== undefined
        && (input.infrastructure === null || typeof input.infrastructure !== 'object'
          || Array.isArray(input.infrastructure)))) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation input 包含无效或不受支持的字段。',
    );
  }
}

export function captureRunOptions(
  value: Readonly<EvaluationRunOptions> | undefined,
): Readonly<EvaluationRunOptions> {
  const input = value === undefined ? {} : value;
  const allowedKeys = new Set([
    'runId',
    'signal',
    'annotations',
    'summaries',
    'eventBufferCapacity',
    'onEvent',
    'clock',
  ]);
  if (input === null || typeof input !== 'object'
      || Object.keys(input).some((key) => !allowedKeys.has(key))
      || (input.runId !== undefined && !IdentifierSchema.safeParse(input.runId).success)
      || (input.eventBufferCapacity !== undefined
        && (!Number.isSafeInteger(input.eventBufferCapacity) || input.eventBufferCapacity < 1))
      || (input.signal !== undefined && (
        input.signal === null || typeof input.signal !== 'object'
        || typeof input.signal.aborted !== 'boolean'
        || typeof input.signal.addEventListener !== 'function'
        || typeof input.signal.removeEventListener !== 'function'
      ))
      || (input.annotations !== undefined && !JsonValueSchema.safeParse(input.annotations).success)
      || (input.summaries !== undefined && !JsonValueSchema.safeParse(input.summaries).success)
      || (input.onEvent !== undefined && typeof input.onEvent !== 'function')
      || (input.clock !== undefined && (
        input.clock === null || typeof input.clock !== 'object'
        || typeof input.clock.monotonicNow !== 'function'
        || typeof input.clock.timestamp !== 'function'
        || typeof input.clock.sleep !== 'function'
      ))) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation run options 包含无效或不受支持的字段。',
    );
  }
  return Object.freeze({
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.annotations === undefined ? {} : {
      annotations: deepFreezeCanonicalJson(structuredClone(input.annotations)),
    }),
    ...(input.summaries === undefined ? {} : {
      summaries: deepFreezeCanonicalJson(structuredClone(input.summaries)),
    }),
    ...(input.eventBufferCapacity === undefined
      ? {}
      : { eventBufferCapacity: input.eventBufferCapacity }),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
}

function collectResolvedRuntimes(plan: SealedRunPlan): readonly RuntimeCapabilityResolution[] {
  const unique = new Map<string, RuntimeCapabilityResolution>();
  for (const runtime of [
    ...plan.execution.runtimes,
    ...plan.evaluation.runtimes,
    ...plan.analysis.runtimes,
    ...plan.decision.runtimes,
  ]) {
    unique.set(canonicalizeJson(runtime), runtime);
  }
  return Object.freeze([...unique.values()].sort((left, right) => (
    compareStrings(
      `${left.runtimeKind}\u0000${left.referenceId}\u0000${canonicalizeJson(left.identity)}`,
      `${right.runtimeKind}\u0000${right.referenceId}\u0000${canonicalizeJson(right.identity)}`,
    )
  )));
}

function estimateEvaluationWork(plan: SealedRunPlan): EvaluationWorkEstimate {
  const trials = plan.execution.experiment.trials;
  const executionCoordinates = derivePlannedExecutionCoordinates(plan);
  const evaluatorsBySampleId = new Map<string, number>();
  for (const sample of plan.evaluation.samples) {
    evaluatorsBySampleId.set(sample.sampleId, plan.evaluation.evaluators.filter((evaluator) => (
      evaluator.applicableSampleIds === undefined
      || evaluator.applicableSampleIds.includes(sample.sampleId)
    )).length);
  }
  const evaluationCoordinates = executionCoordinates.reduce((total, coordinate) => (
    total + (evaluatorsBySampleId.get(coordinate.sampleId) ?? 0)
  ), 0);
  const uncertain: EvaluationWorkEstimate['uncertain'][number][] = [
    'early-termination',
    'active-duration',
    'wall-clock',
    'provider-cost',
  ];
  if (plan.measurementPolicy.retry.maxAttempts > 1
      || plan.measurementPolicy.evaluation.retry.maxAttempts > 1) {
    uncertain.unshift('retries');
  }
  return Object.freeze({
    sampleCount: plan.execution.samples.length,
    variantCount: plan.execution.targets.length,
    trialCount: trials,
    executionCoordinates: executionCoordinates.length,
    evaluationCoordinates,
    plannedInvocations: executionCoordinates.length + evaluationCoordinates,
    uncertain: Object.freeze(uncertain),
  });
}

function validateEvidenceInfrastructure(
  definition: EvaluationDefinition,
  policy: ReturnType<typeof createMeasurementPolicy>,
  variants: readonly Readonly<CapturedVariant>[],
  support: EvaluationRuntimeSupportPorts | undefined,
): void {
  const { evidence } = policy;
  const classificationLevel = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;
  const needsOutput = definition.evaluators.some((evaluator) => (
    evaluator.inputs.some((input) => input.sourceKind === 'output')
  ));
  const needsTrace = definition.evaluators.some((evaluator) => (
    evaluator.inputs.some((input) => input.sourceKind === 'trace')
  ));
  if (needsOutput && evidence.output !== 'full' && evidence.output !== 'reference') {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluator 需要 output；evidence.output 必须是 full 或 reference。',
    );
  }
  if (needsTrace && evidence.trace !== 'full' && evidence.trace !== 'reference') {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluator 需要 trace；evidence.trace 必须是 full 或 reference。',
    );
  }
  if (needsOutput && variants.some((variant) => (
    classificationLevel[variant.mockInterception === undefined
      ? variant.executor.declaration.outputClassification ?? 'sensitive'
      : 'secret']
      > classificationLevel[evidence.maximumClassification]
  ))) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluator 需要 output；evidence.maximumClassification 低于 Executor output classification。',
    );
  }
  if (needsTrace && variants.some((variant) => {
    const declaration = variant.executor.declaration;
    const traceClassification = variant.mockInterception === undefined
      ? declaration.traceClassification ?? declaration.outputClassification ?? 'sensitive'
      : 'secret';
    return classificationLevel[traceClassification]
      > classificationLevel[evidence.maximumClassification];
  })) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluator 需要 trace；evidence.maximumClassification 低于 Executor trace classification。',
    );
  }
  const needsContentStore = evidence.output === 'reference'
    || evidence.trace === 'reference'
    || evidence.evidence === 'reference';
  if (needsContentStore && support?.executionContentStore === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Reference evidence capture requires an infrastructure.contentStore。',
    );
  }
  const needsContentResolver = (needsOutput && evidence.output === 'reference')
    || (needsTrace && evidence.trace === 'reference');
  if (needsContentResolver && support?.contentResolver === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluator 读取 reference content 时需要 infrastructure.contentResolver。',
    );
  }
}

function validateCacheInfrastructure(
  policy: ReturnType<typeof createMeasurementPolicy>,
  support: EvaluationRuntimeSupportPorts | undefined,
  verifier: ExecutorIdentityVerifier | undefined,
): void {
  if (policy.cache.executionMode !== 'disabled' && support?.executionCache === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Execution cache policy requires infrastructure.executionCache。',
    );
  }
  if (policy.cache.evaluationMode === 'reuse' && support?.evaluationCache === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation cache policy requires infrastructure.evaluationCache。',
    );
  }
  if (policy.cache.executionMode === 'transparent-deterministic' && verifier === undefined) {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Execution cache reuse requires infrastructure.executorIdentityVerifier。',
    );
  }
}

async function verifyVariantRuntimeIdentities(
  variants: readonly Readonly<CapturedVariant>[],
  verifier: Readonly<ExecutorIdentityVerifier>,
): Promise<readonly Readonly<CapturedVariant>[]> {
  try {
    return Object.freeze(await Promise.all(variants.map(async (variant) => Object.freeze({
      ...variant,
      runtimeIdentity: await promoteVerifiedExecutorIdentity(
        verifier,
        variant.executor.declaration,
        variant.runtimeIdentity,
      ),
    }))));
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Executor identity verification failed。',
    );
  }
}

async function runPrepared(
  prepared: CorePreparedEvaluation,
  optionsInput?: Readonly<EvaluationRunOptions>,
): Promise<EvaluationResult> {
  const options = captureRunOptions(optionsInput);
  const runId = options.runId ?? `run-${randomUUID()}`;
  try {
    const result = await runPreparedEvaluation({
      prepared,
      runId,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
      ...(options.summaries === undefined ? {} : { summaries: options.summaries }),
      ...(options.eventBufferCapacity === undefined
        ? {}
        : { eventBufferCapacity: options.eventBufferCapacity }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    return attachDefinition(result, runId, prepared.plan);
  } catch (error) {
    if (error instanceof AdvancedEvaluationEventConsumptionError) {
      throw new EvaluationEventConsumptionError({
        code: error.code,
        message: error.message,
        ...(error.runResult === undefined
          ? {}
          : { runResult: attachDefinition(error.runResult, runId, prepared.plan) }),
      });
    }
    throw error;
  }
}

/** Seals one evaluation declaration without calling a Target or Evaluator. */
interface CapturedEvaluationAssembly {
  readonly definition: EvaluationDefinition;
  readonly policy: ReturnType<typeof createMeasurementPolicy>;
  readonly runtime: ReturnType<typeof createEvaluationRuntime>;
}

async function captureEvaluationAssembly(
  input: Readonly<EvaluateInput>,
): Promise<CapturedEvaluationAssembly> {
  if (input === null || typeof input !== 'object') {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation input 无效。',
    );
  }
  assertEvaluateInput(input);
  let capturedInfrastructure: ReturnType<typeof captureEvaluationInfrastructure>;
  try {
    capturedInfrastructure = captureEvaluationInfrastructure(input.infrastructure);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation infrastructure declaration 无效。',
    );
  }
  const support = capturedInfrastructure?.support;
  const dataset = captureDataset(input.dataset);
  const sampleIds = new Set(dataset.samples.map((sample) => sample.sampleId));
  const capturedVariants = input.variants.map((variant) => captureVariant(variant, sampleIds));
  const evaluators = captureEvaluators(dataset, input.evaluators);

  let definition: EvaluationDefinition;
  try {
    definition = createGeneralDefinition({
      variants: capturedVariants,
      evaluators,
      comparisons: input.comparisons,
      experiment: input.experiment,
      analyses: input.analyses,
      ...(input.decision === undefined ? {} : { decision: input.decision }),
    });
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    if (error instanceof EvaluationDefinitionError && error.stage !== 'configuration') {
      throw error;
    }
    if (!(error instanceof EvaluationDefinitionError)
        && !(error instanceof EvaluationRuntimeAssemblyError)) {
      throw error;
    }
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation experiment 无法编译为 Core Definition。',
    );
  }

  let policy;
  try {
    policy = createMeasurementPolicy(input.policy);
  } catch {
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation policy 无效。',
    );
  }
  validateEvidenceInfrastructure(definition, policy, capturedVariants, support);
  validateCacheInfrastructure(
    policy,
    support,
    capturedInfrastructure?.executorIdentityVerifier,
  );
  const variants = policy.cache.executionMode === 'transparent-deterministic'
    ? await verifyVariantRuntimeIdentities(
        capturedVariants,
        capturedInfrastructure!.executorIdentityVerifier!,
      )
    : capturedVariants;
  const variantsByExecutor = new Map<string, Map<string, Readonly<CapturedVariant>>>();
  for (const variant of variants) {
    const executorId = variant.executor.declaration.executorId;
    const byVariant = variantsByExecutor.get(executorId) ?? new Map();
    byVariant.set(variant.variantId, variant);
    variantsByExecutor.set(executorId, byVariant);
  }
  const runtime = createEvaluationRuntime({
    executors: [...variantsByExecutor.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([executorId, byVariant]) => ({
        implementationId: executorId,
        createPort: (requirement) => {
          const variant = byVariant.get(requirement.referenceId);
          if (variant === undefined) {
            return configurationFailure(
              'EVAL_RUNTIME_VARIANT_INVALID',
              'Evaluation Runtime 收到了未知 variant binding。',
            );
          }
          return variant.executor.createPort(variant.variantId, variant.runtimeIdentity);
        },
    })),
    evaluators: evaluators.registrations,
    ...(support === undefined ? {} : { support }),
  });
  return Object.freeze({ definition, policy, runtime });
}

async function prepareCapturedEvaluation(
  assembly: CapturedEvaluationAssembly,
  seriesMembership?: Readonly<EvaluationSeriesMembership>,
): Promise<PreparedEvaluation> {
  try {
    const definition = seriesMembership === undefined
      ? assembly.definition
      : deepFreezeCanonicalJson(EvaluationDefinitionSchema.parse({
          ...assembly.definition,
          seriesMembership,
        }));
    const prepared = await createCoreEvaluationEngine(assembly.runtime).prepare(
      definition,
      assembly.policy,
    );
    const plan = prepared.plan;
    const facade: PreparedEvaluation = Object.freeze({
      definition: plan.definition,
      policy: plan.measurementPolicy,
      plan,
      planDigest: plan.digests.runContractDigest,
      resolvedRuntimes: collectResolvedRuntimes(plan),
      estimatedWork: estimateEvaluationWork(plan),
      run: (options?: Readonly<EvaluationRunOptions>) => runPrepared(prepared, options),
    });
    corePreparedEvaluations.set(facade, prepared);
    return facade;
  } catch (error) {
    if (error instanceof EvaluationConfigurationError) throw error;
    return configurationFailure(
      'EVAL_RUNTIME_INPUT_INVALID',
      'Evaluation 无法封存为可执行 Plan。',
    );
  }
}

/** @internal Captures one declaration once, then seals preregistered Series members from it. */
export async function prepareEvaluationSeriesTemplate(
  input: Readonly<EvaluateInput>,
): Promise<Readonly<{
  base: PreparedEvaluation;
  prepareMembers(
    memberships: readonly Readonly<EvaluationSeriesMembership>[],
  ): Promise<readonly PreparedEvaluation[]>;
}>> {
  const assembly = await captureEvaluationAssembly(input);
  const base = await prepareCapturedEvaluation(assembly);
  let consumed = false;
  return Object.freeze({
    base,
    async prepareMembers(memberships) {
      if (consumed) {
        return configurationFailure(
          'EVAL_RUNTIME_SERIES_INVALID',
          'Evaluation Series member preparation capability 只能使用一次。',
        );
      }
      consumed = true;
      return Promise.all(memberships.map((membership) => (
        prepareCapturedEvaluation(assembly, membership)
      )));
    },
  });
}

/** Seals one evaluation declaration without calling a Target or Evaluator. */
export async function prepareEvaluation(
  input: Readonly<EvaluateInput>,
): Promise<PreparedEvaluation> {
  return prepareCapturedEvaluation(await captureEvaluationAssembly(input));
}

/** Runs one explicit evaluation declaration through OMK's canonical user-facing API. */
export async function evaluate(
  input: Readonly<EvaluateInput>,
  options?: Readonly<EvaluationRunOptions>,
): Promise<EvaluationResult> {
  const capturedOptions = captureRunOptions(options);
  return (await prepareEvaluation(input)).run(capturedOptions);
}
