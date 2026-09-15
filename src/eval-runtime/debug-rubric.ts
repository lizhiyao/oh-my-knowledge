import { deepFreezeCanonicalJson, type UsageRecord } from '../eval-core/contracts/index.js';
import type { Judge, RubricJudgeEvaluator } from './evaluation/contracts.js';
import { captureRubricDeclaration } from './evaluation/rubric-declaration.js';
import { assertLlmJudgeInvocationResult, redactLlmJudgeFailureUsage, type OmkLlmJudgeInvocationRequest } from './judges/invocation.js';
import { decodeRubricReadings, type RubricReading } from './judges/rubric-readings.js';

export type DebugRubricReading = RubricReading;

export type DebugJudgeResponse =
  | Readonly<{ responseStatus: 'completed'; output: string; readings: readonly DebugRubricReading[]; usage?: UsageRecord }>
  | Readonly<{ responseStatus: 'provider-failed'; usage?: UsageRecord }>
  | Readonly<{ responseStatus: 'invalid-response' | 'threw' | 'cancelled' | 'pending' }>;

export interface DebugJudgeInvocation {
  /** Start order within this debug call; not a replicate index or Core attempt number. */
  readonly invocationIndex: number;
  readonly memberId: string;
  readonly request: Readonly<Omit<OmkLlmJudgeInvocationRequest, 'signal'>>;
  readonly response: DebugJudgeResponse;
}

function responseSnapshot(result: unknown, metricIds: readonly string[]): DebugJudgeResponse {
  try {
    assertLlmJudgeInvocationResult(result);
    const usage = redactLlmJudgeFailureUsage(result.usage);
    return deepFreezeCanonicalJson(result.invocationStatus === 'completed'
      ? { responseStatus: 'completed' as const, output: result.output, readings: decodeRubricReadings(metricIds, result.output), ...(usage === undefined ? {} : { usage }) }
      : { responseStatus: 'provider-failed' as const, ...(usage === undefined ? {} : { usage }) });
  } catch {
    // Diagnostics never change the provider return value or disclose its exception.
    return Object.freeze({ responseStatus: 'invalid-response' });
  }
}

/** Per-debug-call collector; no global hooks, log writes, event sinks or retained signals. */
export function captureRubricDebug(value: RubricJudgeEvaluator) {
  const { metricIds } = captureRubricDeclaration(value, 0);
  let collecting = true;
  const invocations: DebugJudgeInvocation[] = [];
  const detach = new Set<() => void>();
  const evaluator: RubricJudgeEvaluator = {
    ...value,
    judges: value.judges.map((member) => {
      const { memberId } = member;
      const invoke = member.judge.invoke;
      const receivers = new WeakMap<Judge, Judge>();
      const originalReceiver = (captured: Judge): Judge => {
        let receiver = receivers.get(captured);
        if (receiver === undefined) {
          receiver = Object.freeze({ ...captured, invoke });
          receivers.set(captured, receiver);
        }
        return receiver;
      };
      return { ...member, judge: {
        judgeId: member.judge.judgeId,
        version: member.judge.version,
        providerCost: member.judge.providerCost,
        ...(member.judge.fingerprintFacets === undefined ? {} : { fingerprintFacets: member.judge.fingerprintFacets }),
        async invoke(this: Judge, request: Readonly<OmkLlmJudgeInvocationRequest>) {
          if (!collecting) return Reflect.apply(invoke, originalReceiver(this), [request]);
          const invocationIndex = invocations.length;
          const { signal, ...wireRequest } = request;
          const initial = Object.freeze({ invocationIndex, memberId, request: Object.freeze(wireRequest), response: Object.freeze({ responseStatus: 'pending' as const }) });
          const update = (response: DebugJudgeResponse) => {
            if (collecting) invocations[invocationIndex] = Object.freeze({ ...initial, response: Object.freeze(response) });
          };
          if (collecting) invocations.push(initial);
          const abort = () => update({ responseStatus: 'cancelled' });
          const remove = () => signal.removeEventListener('abort', abort);
          signal.addEventListener('abort', abort, { once: true });
          detach.add(remove);
          if (signal.aborted) abort();
          try {
            // `this` is the frozen canonical Judge receiver. Restore its original
            // method so a provider sees the same receiver as a normal evaluation.
            const receiver = originalReceiver(this);
            const result = await Reflect.apply(invoke, receiver, [request]);
            if (collecting && !signal.aborted) update(responseSnapshot(result, metricIds));
            return result;
          } catch (error) {
            update({ responseStatus: signal.aborted ? 'cancelled' : 'threw' });
            throw error;
          } finally {
            remove();
            detach.delete(remove);
          }
        },
      } };
    }),
  };
  return {
    evaluator,
    invocations,
    stop() {
      collecting = false;
      for (const remove of detach) remove();
      detach.clear();
    },
  };
}
