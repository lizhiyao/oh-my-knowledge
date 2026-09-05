import { z } from 'zod';
import {
  IdentifierSchema,
  digestCanonicalJson,
} from '../../eval-core/contracts/index.js';
import {
  evaluate,
  type EvaluateInput,
  type Executor,
} from '../evaluate.js';
import type {
  EvaluationCache,
  EvaluationCacheEntry,
  ExecutionCache,
  ExecutionCacheEntry,
  ExecutorIdentityVerifier,
} from '../infrastructure.js';
import type { CustomEvaluator } from '../custom-evaluator.js';

export type CacheConformanceProbeInput = Readonly<
  | {
      cacheKind: 'execution';
      cache: ExecutionCache;
      /** Caller-owned unused namespace; probe entries are intentionally not deleted. */
      probeNamespace: string;
      timeoutMs?: number;
    }
  | {
      cacheKind: 'evaluation';
      cache: EvaluationCache;
      /** Caller-owned unused namespace; probe entries are intentionally not deleted. */
      probeNamespace: string;
      timeoutMs?: number;
    }
>;

export interface CacheConformanceCheck {
  readonly checkId:
    | 'configuration'
    | 'initial-miss'
    | 'write-contract'
    | 'core-hit'
    | 'callback-suppressed'
    | 'key-isolation'
    | 'concurrency-contract';
  readonly checkStatus: 'passed' | 'failed' | 'not-run';
  readonly reasonCode?: string;
}

export interface CacheConformanceResult {
  readonly conformant: boolean;
  readonly cacheKind: 'execution' | 'evaluation';
  readonly checks: readonly CacheConformanceCheck[];
}

class CacheProbeTimeout extends Error {}

function bounded<Output>(operation: Promise<Output>, timeoutMs: number): Promise<Output> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<Output>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new CacheProbeTimeout()), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function check(
  checkId: CacheConformanceCheck['checkId'],
  checkStatus: CacheConformanceCheck['checkStatus'],
  reasonCode: string,
): CacheConformanceCheck {
  return Object.freeze({
    checkId,
    checkStatus,
    ...(checkStatus === 'passed' ? {} : { reasonCode }),
  });
}

function result(
  cacheKind: CacheConformanceResult['cacheKind'],
  checks: readonly CacheConformanceCheck[],
): CacheConformanceResult {
  const captured = Object.freeze([...checks]);
  return Object.freeze({
    cacheKind,
    conformant: captured.every((candidate) => candidate.checkStatus === 'passed'),
    checks: captured,
  });
}

function notRunChecks(
  cacheKind: CacheConformanceResult['cacheKind'],
  reasonCode: string,
): readonly CacheConformanceCheck[] {
  const checkIds: CacheConformanceCheck['checkId'][] = [
    'initial-miss', 'write-contract', 'core-hit', 'callback-suppressed', 'key-isolation',
    ...(cacheKind === 'evaluation' ? ['concurrency-contract' as const] : []),
  ];
  return checkIds
    .map((checkId) => check(checkId, 'not-run', reasonCode));
}

function executionRecord(resultValue: Awaited<ReturnType<typeof evaluate>>) {
  if (resultValue.status !== 'completed') return undefined;
  const record = resultValue.artifacts.execution.records[0];
  return record?.executionStatus === 'completed' ? record : undefined;
}

function evaluationRecord(resultValue: Awaited<ReturnType<typeof evaluate>>) {
  if (resultValue.status !== 'completed') return undefined;
  const record = resultValue.artifacts.evaluation.records[0];
  return record?.evaluationStatus === 'completed' ? record : undefined;
}

function executor(onCall: () => void): Executor<string, undefined, string> {
  return {
    executorId: 'omk.runtime-check.cache-executor/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: z.string() },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe', maxInFlight: 2 },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    fingerprintFacets: { probe: 'omk.runtime-check.cache/v1' },
    async execute({ input, signal }) {
      onCall();
      signal.throwIfAborted();
      return { output: input };
    },
  };
}

function evaluator(onCall: () => void): CustomEvaluator<{ actual: string; expected: string }> {
  return {
    evaluatorKind: 'custom',
    evaluatorId: 'omk-runtime-check-cache-evaluator',
    instrumentId: 'omk.runtime-check.cache-evaluator/v1',
    metric: {
      metricId: 'omk-runtime-check-cache-match',
      valueType: 'boolean',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    },
    bindings: [
      { bindingId: 'actual', sourceKind: 'output', pointer: '' },
      { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
    ],
    implementation: {
      implementationId: 'omk.runtime-check.cache-evaluator/v1',
      version: '1.0.0',
      schemas: {
        bindings: z.object({ actual: z.string(), expected: z.string() }).strict(),
        value: z.boolean(),
        fingerprintFacets: { bindings: 'two-strings/v1', value: 'boolean/v1' },
      },
      fingerprintFacets: { probe: 'omk.runtime-check.cache/v1' },
      async evaluate({ bindings }) {
        onCall();
        return { resultKind: 'score', value: bindings.actual === bindings.expected };
      },
    },
  };
}

function input(
  namespace: string,
  sampleInput: string,
  expected: string,
  target: Executor<string, undefined, string>,
  metricEvaluator: CustomEvaluator<{ actual: string; expected: string }>,
  infrastructure: EvaluateInput['infrastructure'],
  cacheKind: CacheConformanceResult['cacheKind'],
): EvaluateInput {
  return {
    dataset: {
      datasetId: `runtime-check-${namespace}`,
      samples: [{ sampleId: 'probe', input: sampleInput, expected }],
    },
    variants: [{
      variantId: 'candidate',
      artifact: {
        name: `runtime-check-${namespace}`,
        kind: 'baseline',
        source: 'baseline',
        content: null,
      },
      execution: { executor: target },
    }],
    evaluators: [metricEvaluator],
    comparisons: [],
    analyses: [],
    experiment: {
      seed: `runtime-check-${namespace}`,
      sampling: { samplingKind: 'solo' },
    },
    policy: {
      cache: cacheKind === 'execution'
        ? { execution: 'reuse' }
        : { evaluation: 'reuse' },
    },
    infrastructure,
  };
}

/** Exercises one disposable cache namespace through Core miss, write, hit, and key isolation. */
export async function runCacheConformance(
  inputValue: Readonly<CacheConformanceProbeInput>,
): Promise<CacheConformanceResult> {
  const cacheKind = inputValue.cacheKind;
  const timeoutMs = inputValue.timeoutMs ?? 5_000;
  if (!IdentifierSchema.safeParse(inputValue.probeNamespace).success
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || inputValue.cache === null || typeof inputValue.cache !== 'object') {
    return result(cacheKind, [
      check('configuration', 'failed', 'runtime-cache-configuration-invalid'),
      ...notRunChecks(cacheKind, 'runtime-cache-configuration-invalid'),
    ]);
  }

  let capturedGet: ExecutionCache['get'];
  let capturedPut: ExecutionCache['put'];
  try {
    capturedGet = inputValue.cache.get as ExecutionCache['get'];
    capturedPut = inputValue.cache.put as ExecutionCache['put'];
  } catch {
    return result(cacheKind, [
      check('configuration', 'failed', 'runtime-cache-configuration-invalid'),
      ...notRunChecks(cacheKind, 'runtime-cache-configuration-invalid'),
    ]);
  }
  if (typeof capturedGet !== 'function' || typeof capturedPut !== 'function') {
    return result(cacheKind, [
      check('configuration', 'failed', 'runtime-cache-configuration-invalid'),
      ...notRunChecks(cacheKind, 'runtime-cache-configuration-invalid'),
    ]);
  }

  let reads = 0;
  let writes = 0;
  let cacheOperationsInFlight = 0;
  let maximumCacheOperationsInFlight = 0;
  let concurrencyProbeActive = false;
  let concurrentReadsStarted = 0;
  let releaseConcurrentReads: (() => void) | undefined;
  const concurrentReadsReady = new Promise<void>((resolve) => { releaseConcurrentReads = resolve; });
  const keys = new Set<string>();
  const cache = inputValue.cache;
  const wrapped = {
    async get(key: ExecutionCacheEntry['cacheKeyDigest']) {
      reads += 1;
      keys.add(key);
      cacheOperationsInFlight += 1;
      maximumCacheOperationsInFlight = Math.max(
        maximumCacheOperationsInFlight,
        cacheOperationsInFlight,
      );
      try {
        if (concurrencyProbeActive) {
          concurrentReadsStarted += 1;
          if (concurrentReadsStarted === 2) releaseConcurrentReads?.();
          try {
            await bounded(concurrentReadsReady, timeoutMs);
          } catch (error) {
            if (!(error instanceof CacheProbeTimeout)) throw error;
          }
        }
        return await bounded(Promise.resolve(Reflect.apply(capturedGet, cache, [key])), timeoutMs);
      } finally {
        cacheOperationsInFlight -= 1;
      }
    },
    async put(entry: Readonly<ExecutionCacheEntry | EvaluationCacheEntry>) {
      writes += 1;
      keys.add(entry.cacheKeyDigest);
      cacheOperationsInFlight += 1;
      maximumCacheOperationsInFlight = Math.max(
        maximumCacheOperationsInFlight,
        cacheOperationsInFlight,
      );
      try {
        return await bounded(
          Promise.resolve(Reflect.apply(capturedPut, cache, [entry] as never)),
          timeoutMs,
        );
      } finally {
        cacheOperationsInFlight -= 1;
      }
    },
  };
  let targetCalls = 0;
  let evaluatorCalls = 0;
  const target = executor(() => { targetCalls += 1; });
  const metricEvaluator = evaluator(() => { evaluatorCalls += 1; });
  const verifier: ExecutorIdentityVerifier = {
    verifierId: 'omk-runtime-check-cache-verifier',
    async verify({ declaredIdentity }) {
      return {
        attestationDigest: digestCanonicalJson({
          checkStandardId: 'omk.runtime-check.execution-cache/v1',
          probeNamespace: inputValue.probeNamespace,
          declaredFingerprint: declaredIdentity.fingerprint,
        }),
      };
    },
  };
  const infrastructure: EvaluateInput['infrastructure'] = cacheKind === 'execution'
    ? { executionCache: wrapped as ExecutionCache, executorIdentityVerifier: verifier }
    : { evaluationCache: wrapped as EvaluationCache };
  const base = input(
    inputValue.probeNamespace,
    'expected',
    'expected',
    target,
    metricEvaluator,
    infrastructure,
    cacheKind,
  );

  let first: Awaited<ReturnType<typeof evaluate>>;
  let second: Awaited<ReturnType<typeof evaluate>>;
  let isolated: Awaited<ReturnType<typeof evaluate>>;
  let concurrent: Awaited<ReturnType<typeof evaluate>> | undefined;
  const callbackBeforeSecond = () => cacheKind === 'execution' ? targetCalls : evaluatorCalls;
  let beforeSecond = 0;
  let callbackSuppressed = false;
  try {
    first = await evaluate(base, { runId: `runtime-check-${inputValue.probeNamespace}-miss` });
    beforeSecond = callbackBeforeSecond();
    second = await evaluate(base, { runId: `runtime-check-${inputValue.probeNamespace}-hit` });
    callbackSuppressed = callbackBeforeSecond() === beforeSecond;
    isolated = await evaluate(
      input(
        inputValue.probeNamespace,
        cacheKind === 'execution' ? 'different' : 'expected',
        cacheKind === 'evaluation' ? 'different' : 'expected',
        target,
        metricEvaluator,
        infrastructure,
        cacheKind,
      ),
      { runId: `runtime-check-${inputValue.probeNamespace}-isolated` },
    );
    if (cacheKind === 'evaluation') {
      concurrencyProbeActive = true;
      concurrent = await evaluate({
        ...base,
        dataset: {
          ...base.dataset,
          samples: [
            { sampleId: 'parallel-a', input: 'parallel-a', expected: 'parallel-a' },
            { sampleId: 'parallel-b', input: 'parallel-b', expected: 'parallel-b' },
          ],
        },
        policy: {
          ...base.policy,
          execution: { maxConcurrency: 2 },
          evaluation: { maxConcurrency: 2 },
        },
      }, { runId: `runtime-check-${inputValue.probeNamespace}-concurrent` });
      concurrencyProbeActive = false;
    }
  } catch (error) {
    concurrencyProbeActive = false;
    const reasonCode = error instanceof CacheProbeTimeout
      ? 'runtime-cache-operation-timeout'
      : 'runtime-cache-operation-failed';
    return result(cacheKind, [
      check('configuration', 'passed', 'runtime-cache-configuration-invalid'),
      ...notRunChecks(cacheKind, reasonCode),
    ]);
  }

  const firstRecord = cacheKind === 'execution'
    ? executionRecord(first)
    : evaluationRecord(first);
  const secondRecord = cacheKind === 'execution'
    ? executionRecord(second)
    : evaluationRecord(second);
  const isolatedRecord = cacheKind === 'execution'
    ? executionRecord(isolated)
    : evaluationRecord(isolated);
  const concurrentRecords = concurrent?.status === 'completed'
    ? concurrent.artifacts.evaluation.records
    : [];
  const checks: CacheConformanceCheck[] = [
    check('configuration', 'passed', 'runtime-cache-configuration-invalid'),
    check(
      'initial-miss',
      firstRecord?.cache.cacheStatus === 'miss' ? 'passed' : 'failed',
      `runtime-${cacheKind}-cache-initial-miss-invalid`,
    ),
    check(
      'write-contract',
      writes >= 2 && reads >= 3 ? 'passed' : 'failed',
      `runtime-${cacheKind}-cache-write-failed`,
    ),
    check(
      'core-hit',
      secondRecord?.cache.cacheStatus === 'transparent-hit' ? 'passed' : 'failed',
      `runtime-${cacheKind}-cache-core-hit-rejected`,
    ),
    check(
      'callback-suppressed',
      callbackSuppressed ? 'passed' : 'failed',
      cacheKind === 'execution'
        ? 'runtime-execution-cache-hit-executed-target'
        : 'runtime-evaluation-cache-hit-executed-evaluator',
    ),
    check(
      'key-isolation',
      isolatedRecord?.cache.cacheStatus === 'miss' && keys.size >= 2 ? 'passed' : 'failed',
      `runtime-${cacheKind}-cache-key-isolation-failed`,
    ),
    ...(cacheKind === 'evaluation' ? [check(
      'concurrency-contract',
      concurrentRecords.length === 2
        && maximumCacheOperationsInFlight >= 2
        && concurrentRecords.every((record) => (
          'cache' in record && record.cache.cacheStatus === 'miss'
        ))
        ? 'passed'
        : 'failed',
      'runtime-evaluation-cache-concurrency-invalid',
    )] : []),
  ];
  return result(cacheKind, checks);
}
