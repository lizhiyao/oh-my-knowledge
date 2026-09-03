import {
  ExecutorCapabilitiesSchema,
  type RuntimeIdentity,
  type UsageRecord,
} from '../../eval-core/contracts/index.js';
import {
  ExecutionPortFailure,
  type ExecutorAttemptResult,
} from '../../eval-core/execution/index.js';

export function invokeProtocol(identity: Readonly<RuntimeIdentity>) {
  const capabilities = ExecutorCapabilitiesSchema.parse(identity.capabilities);
  const protocol = capabilities.protocols.find((candidate) => (
    candidate.protocolId === 'omk.invoke/v1'
  ));
  if (protocol === undefined) {
    throw new TypeError('Executor adapter identity 必须声明 omk.invoke/v1 capability。');
  }
  return protocol;
}

export function executorContractViolation(message: string, usage?: UsageRecord): never {
  throw new ExecutionPortFailure({
    code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION',
    stage: 'execution',
    message,
  }, usage);
}

export function validateInvokeTelemetry(
  protocol: ReturnType<typeof invokeProtocol>,
  result: Readonly<ExecutorAttemptResult>,
): void {
  const telemetry = protocol.execution.telemetry;
  if (telemetry.trace === 'required' && result.trace === undefined) {
    executorContractViolation('Executor 未返回 Runtime identity 声明为 required 的 trace。', result.usage);
  }
  if (telemetry.trace === 'unsupported' && result.trace !== undefined) {
    executorContractViolation('Executor 返回了 Runtime identity 声明为 unsupported 的 trace。', result.usage);
  }
  const reportsUsage = result.usage !== undefined && (
    result.usage.inputTokens !== undefined
    || result.usage.outputTokens !== undefined
    || result.usage.totalTokens !== undefined
    || result.usage.details !== undefined
  );
  if (telemetry.usage === 'required' && !reportsUsage) {
    executorContractViolation('Executor 未返回 Runtime identity 声明为 required 的 usage。');
  }
  if (telemetry.usage === 'unsupported' && reportsUsage) {
    executorContractViolation('Executor 返回了 Runtime identity 声明为 unsupported 的 usage。');
  }
  const costReporting = telemetry.providerCost?.reporting ?? 'unsupported';
  if (costReporting === 'required' && result.usage?.providerCost === undefined) {
    executorContractViolation('Executor 未返回 Runtime identity 声明为 required 的 provider cost。');
  }
  if (costReporting === 'unsupported' && result.usage?.providerCost !== undefined) {
    executorContractViolation('Executor 返回了 Runtime identity 声明为 unsupported 的 provider cost。');
  }
}

/** Failed invocations may lack telemetry, but must never contradict unsupported declarations. */
export function validateInvokeFailureTelemetry(
  protocol: ReturnType<typeof invokeProtocol>,
  usage: UsageRecord | undefined,
): void {
  const telemetry = protocol.execution.telemetry;
  const reportsUsage = usage !== undefined && (
    usage.inputTokens !== undefined
    || usage.outputTokens !== undefined
    || usage.totalTokens !== undefined
    || usage.details !== undefined
  );
  if (telemetry.usage === 'unsupported' && reportsUsage) {
    executorContractViolation('Executor failure 返回了 Runtime identity 声明为 unsupported 的 usage。');
  }
  const costReporting = telemetry.providerCost?.reporting ?? 'unsupported';
  if (costReporting === 'unsupported' && usage?.providerCost !== undefined) {
    executorContractViolation(
      'Executor failure 返回了 Runtime identity 声明为 unsupported 的 provider cost。',
    );
  }
}
