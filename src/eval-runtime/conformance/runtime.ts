import type { JsonValue } from '../../eval-core/contracts/index.js';
import {
  EvaluationConfigurationError,
  checkContentStore,
  checkExecutor,
  type ContentStoreCheckInput,
  type ContentStoreCheckResult,
  type ExecutorCheckInput,
  type ExecutorCheckResult,
} from '../evaluate.js';
import {
  runCacheConformance,
  type CacheConformanceProbeInput,
  type CacheConformanceResult,
} from './cache.js';
import {
  runWorkspaceProviderConformance,
  type WorkspaceProviderConformanceProbeInput,
  type WorkspaceProviderConformanceResult,
} from './workspace-provider.js';
import {
  runEvaluatorConformance,
  type EvaluatorConformanceProbeInput,
  type EvaluatorConformanceResult,
} from './evaluator.js';
import {
  runJudgeConformance,
  type JudgeConformanceProbeInput,
  type JudgeConformanceResult,
} from './judge.js';

export const RUNTIME_CHECK_RESULT_SCHEMA_VERSION = 'omk.runtime-check-result/v1' as const;

export type RuntimeCheckKind =
  | 'executor'
  | 'evaluator'
  | 'judge'
  | 'cache'
  | 'content-store'
  | 'workspace-provider';

interface RuntimeCheckResultEnvelope<
  RuntimeKind extends RuntimeCheckKind,
  CheckStandardId extends string,
> {
  readonly schemaVersion: typeof RUNTIME_CHECK_RESULT_SCHEMA_VERSION;
  readonly runtimeKind: RuntimeKind;
  readonly checkStandardId: CheckStandardId;
  readonly evidenceLevel: 'behavioral-probe';
}

function invalidInput(message: string): never {
  throw new EvaluationConfigurationError('EVAL_RUNTIME_INPUT_INVALID', message);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function requireConfigured<
  Result extends { readonly checks: readonly Readonly<{
    readonly checkId: string;
    readonly checkStatus: string;
  }>[] },
>(result: Result, checkIds: readonly string[], message: string): Result {
  if (result.checks.some((candidate) => (
    checkIds.includes(candidate.checkId) && candidate.checkStatus !== 'passed'
  ))) return invalidInput(message);
  return result;
}

export type ExecutorRuntimeCheckInput<
  Input extends JsonValue = JsonValue,
  Config extends JsonValue | undefined = JsonValue | undefined,
  Output extends JsonValue = JsonValue,
  Trace extends JsonValue = JsonValue,
> = Readonly<{ readonly runtimeKind: 'executor' }
  & ExecutorCheckInput<Input, Config, Output, Trace>>;

export type ExecutorRuntimeCheckResult = Readonly<
  RuntimeCheckResultEnvelope<'executor', 'omk.runtime-check.executor/v1'>
  & Omit<ExecutorCheckResult, 'run'>
>;

export type ContentStoreRuntimeCheckInput = Readonly<
  { readonly runtimeKind: 'content-store' } & ContentStoreCheckInput
>;

export type ContentStoreRuntimeCheckResult = Readonly<
  RuntimeCheckResultEnvelope<'content-store', 'omk.runtime-check.content-store/v1'>
  & ContentStoreCheckResult
>;

export type CacheRuntimeCheckInput = Readonly<
  { readonly runtimeKind: 'cache' } & CacheConformanceProbeInput
>;

export type CacheRuntimeCheckResult = Readonly<
  RuntimeCheckResultEnvelope<
    'cache',
    'omk.runtime-check.execution-cache/v1' | 'omk.runtime-check.evaluation-cache/v1'
  > & CacheConformanceResult
>;

export type WorkspaceProviderRuntimeCheckInput = Readonly<
  { readonly runtimeKind: 'workspace-provider' } & WorkspaceProviderConformanceProbeInput
>;

export type WorkspaceProviderRuntimeCheckResult = Readonly<
  RuntimeCheckResultEnvelope<'workspace-provider', 'omk.runtime-check.workspace-provider/v1'>
  & WorkspaceProviderConformanceResult
>;

export type EvaluatorRuntimeCheckInput<
  Bindings extends Record<string, JsonValue> = Record<string, JsonValue>,
  Parameters extends JsonValue | undefined = JsonValue | undefined,
> = Readonly<
  { readonly runtimeKind: 'evaluator' }
  & EvaluatorConformanceProbeInput<Bindings, Parameters>
>;

export type EvaluatorRuntimeCheckResult = Readonly<
  RuntimeCheckResultEnvelope<'evaluator', 'omk.runtime-check.custom-evaluator/v1'>
  & EvaluatorConformanceResult
>;

export type JudgeRuntimeCheckInput = Readonly<
  { readonly runtimeKind: 'judge' } & JudgeConformanceProbeInput
>;

export type JudgeRuntimeCheckResult = Readonly<
  RuntimeCheckResultEnvelope<'judge', 'omk.runtime-check.judge/v1'>
  & JudgeConformanceResult
>;

export type RuntimeCheckInput =
  | ExecutorRuntimeCheckInput
  | EvaluatorRuntimeCheckInput
  | JudgeRuntimeCheckInput
  | CacheRuntimeCheckInput
  | ContentStoreRuntimeCheckInput
  | WorkspaceProviderRuntimeCheckInput;

export type RuntimeCheckResult =
  | ExecutorRuntimeCheckResult
  | EvaluatorRuntimeCheckResult
  | JudgeRuntimeCheckResult
  | CacheRuntimeCheckResult
  | ContentStoreRuntimeCheckResult
  | WorkspaceProviderRuntimeCheckResult;

function envelope<
  RuntimeKind extends RuntimeCheckKind,
  CheckStandardId extends string,
  Result extends object,
>(
  runtimeKind: RuntimeKind,
  checkStandardId: CheckStandardId,
  result: Result,
): Readonly<RuntimeCheckResultEnvelope<RuntimeKind, CheckStandardId> & Result> {
  return Object.freeze({
    schemaVersion: RUNTIME_CHECK_RESULT_SCHEMA_VERSION,
    runtimeKind,
    checkStandardId,
    evidenceLevel: 'behavioral-probe',
    ...result,
  });
}

export function checkRuntime<
  Input extends JsonValue,
  Config extends JsonValue | undefined,
  Output extends JsonValue,
  Trace extends JsonValue = JsonValue,
>(
  input: ExecutorRuntimeCheckInput<Input, Config, Output, Trace>,
): Promise<ExecutorRuntimeCheckResult>;
export function checkRuntime(
  input: ContentStoreRuntimeCheckInput,
): Promise<ContentStoreRuntimeCheckResult>;
export function checkRuntime(
  input: CacheRuntimeCheckInput,
): Promise<CacheRuntimeCheckResult>;
export function checkRuntime(
  input: WorkspaceProviderRuntimeCheckInput,
): Promise<WorkspaceProviderRuntimeCheckResult>;
export function checkRuntime<
  Bindings extends Record<string, JsonValue>,
  Parameters extends JsonValue | undefined,
>(
  input: EvaluatorRuntimeCheckInput<Bindings, Parameters>,
): Promise<EvaluatorRuntimeCheckResult>;
export function checkRuntime(
  input: JudgeRuntimeCheckInput,
): Promise<JudgeRuntimeCheckResult>;
export function checkRuntime(input: RuntimeCheckInput): Promise<RuntimeCheckResult>;
export async function checkRuntime(input: RuntimeCheckInput): Promise<RuntimeCheckResult> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return invalidInput('Runtime check input 无效。');
  }
  if (input.runtimeKind === 'executor') {
    if (!hasOnlyKeys(input, [
      'runtimeKind', 'variant', 'success', 'failure', 'cancellation', 'seed', 'runId',
    ])) return invalidInput('Executor runtime check input 包含不支持的字段。');
    return checkExecutor({
      variant: input.variant,
      success: input.success,
      failure: input.failure,
      cancellation: input.cancellation,
      ...(input.seed === undefined ? {} : { seed: input.seed }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    }).then((result) => envelope(
      'executor',
      'omk.runtime-check.executor/v1',
      Object.freeze({ conformant: result.conformant, checks: result.checks }),
    ));
  }
  if (input.runtimeKind === 'content-store') {
    if (!hasOnlyKeys(input, [
      'runtimeKind', 'contentStore', 'contentResolver', 'probe', 'timeoutMs',
    ])) return invalidInput('ContentStore runtime check input 包含不支持的字段。');
    return checkContentStore({
      contentStore: input.contentStore,
      contentResolver: input.contentResolver,
      ...(input.probe === undefined ? {} : { probe: input.probe }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }).then((result) => envelope(
      'content-store',
      'omk.runtime-check.content-store/v1',
      result,
    ));
  }
  if (input.runtimeKind === 'cache') {
    if (!hasOnlyKeys(input, [
      'runtimeKind', 'cacheKind', 'cache', 'probeNamespace', 'timeoutMs',
    ]) || (input.cacheKind !== 'execution' && input.cacheKind !== 'evaluation')) {
      return invalidInput('Cache runtime check input 无效。');
    }
    const probe: CacheConformanceProbeInput = input.cacheKind === 'execution'
      ? {
          cacheKind: 'execution',
          cache: input.cache,
          probeNamespace: input.probeNamespace,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        }
      : {
          cacheKind: 'evaluation',
          cache: input.cache,
          probeNamespace: input.probeNamespace,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        };
    return runCacheConformance(probe).then((result) => envelope(
      'cache',
      `omk.runtime-check.${input.cacheKind}-cache/v1`,
      requireConfigured(result, ['configuration'], 'Cache runtime check declaration 无效。'),
    ));
  }
  if (input.runtimeKind === 'workspace-provider') {
    if (!hasOnlyKeys(input, [
      'runtimeKind', 'provider', 'descriptor', 'probeNamespace', 'timeoutMs',
    ])) return invalidInput('WorkspaceProvider runtime check input 包含不支持的字段。');
    return runWorkspaceProviderConformance({
      provider: input.provider,
      descriptor: input.descriptor,
      probeNamespace: input.probeNamespace,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }).then((result) => envelope(
      'workspace-provider',
      'omk.runtime-check.workspace-provider/v1',
      requireConfigured(
        result,
        ['configuration'],
        'WorkspaceProvider runtime check declaration 无效。',
      ),
    ));
  }
  if (input.runtimeKind === 'evaluator') {
    if (!hasOnlyKeys(input, [
      'runtimeKind', 'evaluator', 'score', 'missing', 'invalid', 'failure', 'cancellation',
      'probeNamespace', 'timeoutMs',
    ])) return invalidInput('Evaluator runtime check input 包含不支持的字段。');
    return runEvaluatorConformance({
      evaluator: input.evaluator,
      score: input.score,
      missing: input.missing,
      invalid: input.invalid,
      failure: input.failure,
      cancellation: input.cancellation,
      probeNamespace: input.probeNamespace,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }).then((result) => envelope(
      'evaluator',
      'omk.runtime-check.custom-evaluator/v1',
      requireConfigured(result, ['configuration'], 'Evaluator runtime check declaration 无效。'),
    ));
  }
  if (input.runtimeKind === 'judge') {
    if (!hasOnlyKeys(input, [
      'runtimeKind', 'judge', 'model', 'success', 'invalidResponse', 'failure', 'cancellation',
      'probeNamespace', 'allowExternalCalls', 'timeoutMs',
    ])) return invalidInput('Judge runtime check input 包含不支持的字段。');
    if (input.allowExternalCalls !== true) {
      return invalidInput('Judge runtime check 需要显式设置 allowExternalCalls: true。');
    }
    return runJudgeConformance({
      judge: input.judge,
      model: input.model,
      success: input.success,
      invalidResponse: input.invalidResponse,
      failure: input.failure,
      cancellation: input.cancellation,
      probeNamespace: input.probeNamespace,
      allowExternalCalls: input.allowExternalCalls,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    }).then((result) => envelope(
      'judge',
      'omk.runtime-check.judge/v1',
      requireConfigured(
        result,
        ['configuration', 'external-calls-authorized'],
        'Judge runtime check declaration 无效。',
      ),
    ));
  }
  return invalidInput('Runtime check runtimeKind 无效。');
}
