import { z } from 'zod';
import { canonicalizeJson } from '../../eval-core/contracts/index.js';
import {
  prepareEvaluation,
  type EvaluateInput,
  type EvaluationResult,
  type Executor,
} from '../evaluate.js';
import {
  captureWorkspaceProvider,
  type WorkspaceDescriptor,
  type WorkspaceLease,
  type WorkspaceOpenRequest,
  type WorkspaceProvider,
} from '../workspace.js';

export interface WorkspaceProviderConformanceProbeInput {
  readonly provider: WorkspaceProvider;
  readonly descriptor: WorkspaceDescriptor;
  /** Caller-owned identity for this disposable probe. */
  readonly probeNamespace: string;
  /** Abort deadline for cooperative providers; defaults to 5 seconds. */
  readonly timeoutMs?: number;
}

export interface WorkspaceProviderConformanceCheck {
  readonly checkId:
    | 'configuration'
    | 'prepare-no-effects'
    | 'request-contract'
    | 'lease-isolation'
    | 'target-access'
    | 'retry-reuse'
    | 'success-cleanup'
    | 'failure-cleanup'
    | 'cancellation-cleanup'
    | 'locator-redaction';
  readonly checkStatus: 'passed' | 'failed' | 'not-run';
  readonly reasonCode?: string;
}

export interface WorkspaceProviderConformanceResult {
  readonly conformant: boolean;
  readonly checks: readonly WorkspaceProviderConformanceCheck[];
}

type ProbePhase = 'success' | 'retry' | 'failure' | 'cancellation';

interface LeaseObservation {
  readonly phase: ProbePhase;
  readonly sampleId: string;
  readonly lease: WorkspaceLease;
  readonly root: string;
  closes: number;
}

class WorkspaceCleanupTimeout extends Error {}

function boundedCleanup(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new WorkspaceCleanupTimeout()), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function check(
  checkId: WorkspaceProviderConformanceCheck['checkId'],
  passed: boolean,
  reasonCode: string,
): WorkspaceProviderConformanceCheck {
  return Object.freeze({
    checkId,
    checkStatus: passed ? 'passed' : 'failed',
    ...(passed ? {} : { reasonCode }),
  });
}

function result(
  checks: readonly WorkspaceProviderConformanceCheck[],
): WorkspaceProviderConformanceResult {
  const captured = Object.freeze([...checks]);
  return Object.freeze({
    conformant: captured.every((candidate) => candidate.checkStatus === 'passed'),
    checks: captured,
  });
}

function executor(
  provider: WorkspaceProvider,
  phase: ProbePhase,
  accesses: Array<Readonly<{ phase: ProbePhase; sampleId: string; root: string }>>,
  onCancellationStart: () => void,
): Executor<string, undefined, string> {
  return {
    executorId: 'omk.runtime-check.workspace-executor/v1',
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
    fingerprintFacets: { probe: 'omk.runtime-check.workspace-provider/v1' },
    workspaceProvider: provider,
    async execute({ sampleId, attemptNumber, workspace, signal }) {
      if (workspace === undefined) return { errorCode: 'runtime-workspace-access-missing' };
      accesses.push({ phase, sampleId, root: workspace.root });
      if (phase === 'retry' && attemptNumber === 1) {
        return { errorCode: 'runtime-workspace-retry-probe' };
      }
      if (phase === 'failure') return { errorCode: 'runtime-workspace-probe-failure' };
      if (phase === 'cancellation') {
        onCancellationStart();
        await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return { output: 'expected' };
    },
  };
}

function evaluationInput(
  namespace: string,
  phase: ProbePhase,
  target: Executor<string, undefined, string>,
  descriptor: WorkspaceDescriptor,
): EvaluateInput {
  const sampleIds = phase === 'success' ? ['one', 'two'] : [phase];
  return {
    dataset: {
      datasetId: `runtime-check-${namespace}-${phase}`,
      samples: sampleIds.map((sampleId) => ({ sampleId, input: sampleId, expected: 'expected' })),
    },
    variants: [{
      variantId: 'candidate',
      artifact: {
        name: `runtime-check-${namespace}`,
        kind: 'agent',
        source: 'inline',
        content: 'Workspace provider behavioral probe.',
      },
      execution: { executor: target, workspace: descriptor },
    }],
    evaluators: [{ evaluatorKind: 'exact-match' }],
    comparisons: [],
    analyses: [],
    experiment: {
      seed: `runtime-check-${namespace}`,
      sampling: { samplingKind: 'solo' },
    },
    policy: {
      execution: {
        maxConcurrency: 2,
        ...(phase === 'retry' ? {
          retry: {
            maxAttempts: 2,
            retryableErrorCodes: ['runtime-workspace-retry-probe'],
            backoff: { backoffKind: 'none' as const },
          },
        } : {}),
      },
    },
  };
}

/** Exercises request forwarding, concurrent isolation, cancellation, and terminal cleanup. */
export async function runWorkspaceProviderConformance(
  input: Readonly<WorkspaceProviderConformanceProbeInput>,
): Promise<WorkspaceProviderConformanceResult> {
  const timeoutMs = input.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return result([check('configuration', false, 'runtime-workspace-configuration-invalid')]);
  }
  let capturedProvider: ReturnType<typeof captureWorkspaceProvider>;
  try {
    capturedProvider = captureWorkspaceProvider(input.provider);
  } catch {
    return result([check('configuration', false, 'runtime-workspace-configuration-invalid')]);
  }
  if (capturedProvider === undefined) {
    return result([check('configuration', false, 'runtime-workspace-configuration-invalid')]);
  }

  const requests: Array<Readonly<{ phase: ProbePhase; request: WorkspaceOpenRequest }>> = [];
  const leases: LeaseObservation[] = [];
  const accesses: Array<Readonly<{ phase: ProbePhase; sampleId: string; root: string }>> = [];
  const wrappedByLease = new WeakMap<object, WorkspaceLease>();
  let phase: ProbePhase = 'success';
  const observedProvider: WorkspaceProvider = {
    providerId: capturedProvider.providerId,
    version: capturedProvider.version,
    ...(capturedProvider.fingerprintFacets === undefined
      ? {}
      : { fingerprintFacets: capturedProvider.fingerprintFacets }),
    async open(request) {
      const requestPhase = phase;
      requests.push({ phase: requestPhase, request });
      const lease = await capturedProvider.open(request);
      if (lease === null || typeof lease !== 'object') return lease;
      const existing = wrappedByLease.get(lease);
      if (existing !== undefined) return existing;
      let close: WorkspaceLease['close'] | undefined;
      try {
        close = lease.close;
      } catch {
        return lease;
      }
      if (typeof lease.root !== 'string' || typeof close !== 'function') return lease;
      const observation: LeaseObservation = {
        phase: requestPhase,
        sampleId: request.sampleId,
        lease,
        root: lease.root,
        closes: 0,
      };
      leases.push(observation);
      const wrapped: WorkspaceLease = {
        root: lease.root,
        async close() {
          observation.closes += 1;
          await boundedCleanup(
            Promise.resolve(Reflect.apply(close, lease, [])),
            timeoutMs,
          );
        },
      };
      wrappedByLease.set(lease, wrapped);
      return wrapped;
    },
  };

  const runs: EvaluationResult[] = [];
  let prepareHadEffects = false;
  for (const candidatePhase of ['success', 'retry', 'failure', 'cancellation'] as const) {
    phase = candidatePhase;
    let markCancellationStart: (() => void) | undefined;
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStart = resolve;
    });
    const target = executor(
      observedProvider,
      candidatePhase,
      accesses,
      () => markCancellationStart?.(),
    );
    let prepared: Awaited<ReturnType<typeof prepareEvaluation>>;
    try {
      const opensBeforePrepare = requests.length;
      prepared = await prepareEvaluation(evaluationInput(
        input.probeNamespace,
        candidatePhase,
        target,
        input.descriptor,
      ));
      prepareHadEffects ||= requests.length !== opensBeforePrepare;
    } catch {
      return result([check('configuration', false, 'runtime-workspace-configuration-invalid')]);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = prepared.run({
        runId: `runtime-check-${input.probeNamespace}-${candidatePhase}`,
        signal: controller.signal,
      });
      if (candidatePhase === 'cancellation') {
        await Promise.race([
          cancellationStarted,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
        controller.abort('runtime workspace cancellation probe');
      } else {
        timer = setTimeout(() => controller.abort('runtime workspace probe timeout'), timeoutMs);
      }
      runs.push(await pending);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  const descriptor = canonicalizeJson(input.descriptor);
  const roots = leases.map((lease) => lease.root);
  const requestContract = requests.length === 5 && requests.every(({ request }) => (
    request.signal instanceof AbortSignal
    && canonicalizeJson(request.descriptor) === descriptor
    && request.variantId === 'candidate'
    && request.runId.startsWith(`runtime-check-${input.probeNamespace}-`)
  ));
  const leaseIsolation = leases.length === 5
    && new Set(leases.map((lease) => lease.lease)).size === leases.length
    && new Set(leases
      .filter((lease) => lease.phase === 'success')
      .map((lease) => lease.root)).size === 2;
  const successLeases = leases.filter((lease) => lease.phase === 'success');
  const retryLeases = leases.filter((lease) => lease.phase === 'retry');
  const failureLeases = leases.filter((lease) => lease.phase === 'failure');
  const cancellationLeases = leases.filter((lease) => lease.phase === 'cancellation');
  const retryAccesses = accesses.filter((access) => access.phase === 'retry');
  const targetAccess = accesses.length === 6 && accesses.every((access) => (
    leases.some((lease) => lease.phase === access.phase
      && lease.sampleId === access.sampleId && lease.root === access.root)
  ));
  const serializedRuns = JSON.stringify(runs);
  return result([
    check('configuration', true, 'runtime-workspace-configuration-invalid'),
    check('prepare-no-effects', !prepareHadEffects, 'runtime-workspace-prepare-had-effects'),
    check('request-contract', requestContract, 'runtime-workspace-request-mismatch'),
    check('lease-isolation', leaseIsolation, 'runtime-workspace-lease-not-isolated'),
    check('target-access', targetAccess, 'runtime-workspace-target-access-invalid'),
    check(
      'retry-reuse',
      runs[1]?.status === 'completed'
        && retryLeases.length === 1
        && retryLeases[0]?.closes === 1
        && retryAccesses.length === 2
        && retryAccesses.every((access) => access.root === retryLeases[0]?.root),
      'runtime-workspace-retry-reuse-failed',
    ),
    check(
      'success-cleanup',
      runs[0]?.status === 'completed'
        && successLeases.length === 2
        && successLeases.every((lease) => lease.closes === 1),
      'runtime-workspace-success-cleanup-incomplete',
    ),
    check(
      'failure-cleanup',
      runs[2]?.status === 'completed'
        && runs[2].artifacts.execution.records[0]?.executionStatus === 'failed'
        && runs[2].artifacts.execution.records[0].error.code
          === 'runtime-workspace-probe-failure'
        && failureLeases.length === 1
        && failureLeases[0]?.closes === 1,
      'runtime-workspace-failure-cleanup-incomplete',
    ),
    check(
      'cancellation-cleanup',
      runs[3]?.status === 'cancelled'
        && cancellationLeases.length === 1
        && cancellationLeases[0]?.closes === 1,
      'runtime-workspace-cancellation-cleanup-incomplete',
    ),
    check(
      'locator-redaction',
      roots.every((root) => !serializedRuns.includes(root)),
      'runtime-workspace-locator-leaked',
    ),
  ]);
}
