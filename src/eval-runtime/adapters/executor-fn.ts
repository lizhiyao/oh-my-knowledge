import {
  ExecutorCapabilitiesSchema,
  type JsonValue,
  type RuntimeIdentity,
  type UsageRecord,
} from '../../eval-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutorAttemptResult,
  type ExecutorTrialContext,
} from '../../eval-core/execution/index.js';
import type { ExecutorFn, ExecutorInput } from '../../executors/contracts/ports.js';
import type { ExecResult } from '../../executors/contracts/result.js';
import { createSameProcessExecutorAdapter } from './same-process.js';

export type ExecutorFnInputMapper = (
  context: Readonly<ExecutorTrialContext>,
) => Omit<ExecutorInput, 'abortSignal'>;

export type ExecutorFnResultMapper = (
  result: Readonly<ExecResult>,
  context: Readonly<ExecutorTrialContext>,
) => ExecutorAttemptResult;

export interface CreateExecutorFnAdapterInput {
  readonly identity: RuntimeIdentity;
  readonly executor: ExecutorFn;
  readonly mapInput: ExecutorFnInputMapper;
  readonly outputClassification: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly outputMediaType?: string;
  readonly mapResult?: ExecutorFnResultMapper;
  readonly sessionIsolationKey?: string;
}

function reportedUsage(result: Readonly<ExecResult>): UsageRecord | undefined {
  const usage: UsageRecord = {};
  if (result.tokenUsageReportedByExecutor !== false) {
    usage.inputTokens = result.inputTokens;
    usage.outputTokens = result.outputTokens;
    usage.totalTokens = result.inputTokens + result.outputTokens;
  }
  if (result.costReportedByExecutor !== false) {
    usage.providerCost = {
      amount: result.costUSD,
      currency: 'USD',
      reportedByProvider: true,
    };
  }
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function contractViolation(message: string, usage?: UsageRecord): never {
  throw new ExecutionPortFailure({
    code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION',
    stage: 'execution',
    message,
  }, usage);
}

/**
 * Adapts OMK's existing `ExecutorFn` invocation protocol to the Core Executor port.
 * Core remains responsible for retries, timeouts, budgets, and cancellation.
 */
export function createExecutorFnAdapter(
  input: Readonly<CreateExecutorFnAdapterInput>,
) {
  const capabilities = ExecutorCapabilitiesSchema.parse(input.identity.capabilities);
  const protocol = capabilities.protocols.find((candidate) => (
    candidate.protocolId === 'omk.invoke/v1'
  ));
  if (protocol === undefined) {
    throw new TypeError('ExecutorFn adapter identity 必须声明 omk.invoke/v1 capability。');
  }
  const executor = input.executor;
  const mapInput = input.mapInput;
  const mapResult = input.mapResult;
  const classification = input.outputClassification;
  const mediaType = input.outputMediaType;
  return createSameProcessExecutorAdapter({
    identity: input.identity,
    sessionIsolationKey: input.sessionIsolationKey
      ?? `eval-runtime:${input.identity.implementationId}`,
    resourceLeases: { forRun: () => undefined },
    implementation: {
      openRun: () => undefined,
      openTrial: ({ trial }) => trial,
      async execute({ trial, attempt }): Promise<ExecutorAttemptResult> {
        if (attempt.signal.aborted) throw attempt.signal.reason;
        const result = await executor({
          ...structuredClone(mapInput(trial)),
          abortSignal: attempt.signal,
        });
        const usage = reportedUsage(result);
        if (!result.ok) {
          throw new ExecutionPortFailure({
            code: 'EVAL_RUNTIME_EXECUTOR_FAILED',
            stage: 'execution',
            message: 'Host ExecutorFn 执行失败。',
          }, usage);
        }
        const mapped = mapResult !== undefined ? mapResult(result, trial) : {
          ...(result.output === null
            ? {}
            : {
                output: {
                  value: result.output as JsonValue,
                  classification,
                  ...(mediaType === undefined ? {} : { mediaType }),
                },
              }),
          ...(usage === undefined ? {} : { usage }),
        };
        const telemetry = protocol.execution.telemetry;
        if (telemetry.trace === 'required' && mapped.trace === undefined) {
          return contractViolation('ExecutorFn 未返回 Runtime identity 声明为 required 的 trace。', usage);
        }
        if (telemetry.trace === 'unsupported' && mapped.trace !== undefined) {
          return contractViolation('ExecutorFn 返回了 Runtime identity 声明为 unsupported 的 trace。', usage);
        }
        if (telemetry.usage === 'required' && mapped.usage === undefined) {
          return contractViolation('ExecutorFn 未返回 Runtime identity 声明为 required 的 usage。');
        }
        const costReporting = telemetry.providerCost?.reporting ?? 'unsupported';
        if (costReporting === 'required' && mapped.usage?.providerCost === undefined) {
          return contractViolation('ExecutorFn 未返回 Runtime identity 声明为 required 的 provider cost。');
        }
        if (costReporting === 'unsupported' && mapped.usage?.providerCost !== undefined) {
          return contractViolation('ExecutorFn 返回了 Runtime identity 声明为 unsupported 的 provider cost。');
        }
        return mapped;
      },
      disposeTrial: () => undefined,
      disposeRun: () => undefined,
    },
  });
}

export type { ExecutorFn, ExecutorInput, ExecResult };
