import type { RuntimeIdentity, UsageRecord } from '../../../eval-core/contracts/index.js';
import type { ExecutorFn } from '../../../executors/contracts/ports.js';
import type { OmkLlmJudgeInvocationPort, OmkLlmJudgeInvocationRequest } from './llm-judge-invocation.js';

function usage(result: Awaited<ReturnType<ExecutorFn>>): UsageRecord | undefined {
  const value: UsageRecord = {
    ...(result.tokenUsageReportedByExecutor === false ? {} : {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.inputTokens + result.outputTokens,
    }),
    ...(result.costReportedByExecutor === false ? {} : {
      providerCost: {
        amount: result.costUSD,
        currency: 'USD',
        reportedByProvider: true,
      },
    }),
  };
  return Object.keys(value).length === 0 ? undefined : value;
}

/** Adapts one executor call; identity, preflight, retries and cancellation policy remain caller-owned. */
export function createExecutorJudgeInvocationPort(
  executor: ExecutorFn,
  identity: RuntimeIdentity,
): OmkLlmJudgeInvocationPort {
  return Object.freeze({
    identity,
    providerCost: { reporting: 'optional' as const },
    async invoke(request: Readonly<OmkLlmJudgeInvocationRequest>) {
      try {
        const result = await executor({
          model: request.model,
          system: request.system,
          prompt: request.prompt,
          effort: request.effort,
          abortSignal: request.signal,
        });
        const measuredUsage = usage(result);
        return result.ok && result.output !== null
          ? {
              invocationStatus: 'completed' as const,
              output: result.output,
              ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
            }
          : {
              invocationStatus: 'failed' as const,
              reasonCode: request.signal.aborted
                ? 'provider-invocation-cancelled'
                : 'provider-invocation-failed',
              ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
            };
      } catch {
        return {
          invocationStatus: 'failed' as const,
          reasonCode: request.signal.aborted
            ? 'provider-invocation-cancelled'
            : 'provider-invocation-failed',
        };
      }
    },
  });
}
