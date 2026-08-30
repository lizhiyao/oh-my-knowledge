import {
  ExecutionBundleSchema,
  type ExecutionBundle,
  type ExecutionAttempt,
  type ExecutionRecord,
  type UsageRecord,
} from './artifacts.js';
import type { CapturedContent, Provenance, RuntimeIdentity } from './common.js';
import { budgetSummaryMatchesPolicy } from './budget.js';
import {
  deriveAttemptId,
  derivePlannedExecutionCoordinates,
  deriveTrialId,
  type ExecutionIdentityPlanContext,
  type PlannedExecutionCoordinate,
} from './execution-identities.js';
import { digestArtifactPayload } from './digests.js';
import {
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
  type Sha256Digest,
} from './json.js';

export type ExecutionBundleValidationErrorCode =
  | 'EXECUTION_BUNDLE_DUPLICATE_COORDINATE'
  | 'EXECUTION_BUNDLE_IDENTITY_MISMATCH'
  | 'EXECUTION_BUNDLE_RANDOMIZATION_SLOT_INVALID'
  | 'EXECUTION_BUNDLE_RECORD_ORDER_INVALID'
  | 'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID'
  | 'EXECUTION_BUNDLE_BLOCK_ATOMICITY_INVALID'
  | 'EXECUTION_BUNDLE_COVERAGE_INVALID'
  | 'EXECUTION_BUNDLE_STATUS_INVALID'
  | 'EXECUTION_BUNDLE_REPLAYABILITY_INVALID'
  | 'EXECUTION_BUNDLE_EVIDENCE_POLICY_INVALID'
  | 'EXECUTION_BUNDLE_USAGE_INVALID'
  | 'EXECUTION_BUNDLE_BUDGET_SUMMARY_INVALID'
  | 'EXECUTION_BUNDLE_CACHE_POLICY_INVALID'
  | 'EXECUTION_BUNDLE_PROVIDER_COST_INVALID'
  | 'EXECUTION_BUNDLE_PROVENANCE_INVALID'
  | 'EXECUTION_BUNDLE_DIGEST_MISMATCH'
  | 'EXECUTION_BUNDLE_PLAN_MISMATCH'
  | 'EXECUTION_BUNDLE_RETRY_POLICY_INVALID';

export class ExecutionBundleValidationError extends TypeError {
  readonly code: ExecutionBundleValidationErrorCode;

  constructor(code: ExecutionBundleValidationErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionBundleValidationError';
    this.code = code;
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRecordCoordinates(left: ExecutionRecord, right: ExecutionRecord): number {
  return compareStrings(left.targetId, right.targetId)
    || compareStrings(left.sampleId, right.sampleId)
    || left.trialIndex - right.trialIndex;
}

function assertCanonicalRecordOrder(records: readonly ExecutionRecord[]): void {
  for (let index = 1; index < records.length; index += 1) {
    const order = compareRecordCoordinates(records[index - 1], records[index]);
    if (order >= 0) {
      throw new ExecutionBundleValidationError(
        order === 0
          ? 'EXECUTION_BUNDLE_DUPLICATE_COORDINATE'
          : 'EXECUTION_BUNDLE_RECORD_ORDER_INVALID',
        order === 0
          ? 'ExecutionBundle contains a duplicate execution coordinate.'
          : 'ExecutionBundle records must use canonical target/sample/trial order.',
      );
    }
  }
}

function assertRecordIdentities(bundle: ExecutionBundle): void {
  const trialIds = new Set<string>();
  const attemptIds = new Set<string>();
  const slotsByTarget = new Map<string, string>();
  const targetsBySlot = new Map<string, string>();
  for (const record of bundle.records) {
    const targetSlot = slotsByTarget.get(record.targetId);
    const slotTarget = targetsBySlot.get(record.randomizationSlotId);
    if ((targetSlot !== undefined && targetSlot !== record.randomizationSlotId)
        || (slotTarget !== undefined && slotTarget !== record.targetId)) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_RANDOMIZATION_SLOT_INVALID',
        'ExecutionBundle must preserve a one-to-one Target and randomization slot mapping.',
      );
    }
    slotsByTarget.set(record.targetId, record.randomizationSlotId);
    targetsBySlot.set(record.randomizationSlotId, record.targetId);
    const expectedTrialId = deriveTrialId({
      executionPlanDigest: bundle.executionPlanDigest as Sha256Digest,
      targetId: record.targetId,
      sampleId: record.sampleId,
      trialIndex: record.trialIndex,
    });
    if (record.trialId !== expectedTrialId || trialIds.has(record.trialId)) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_IDENTITY_MISMATCH',
        'ExecutionRecord trial identity does not match its canonical coordinate.',
      );
    }
    trialIds.add(record.trialId);
    if (record.executionStatus === 'budget-censored') continue;
    assertExecutionRecordAttemptSemantics(record);
    for (const attempt of record.attempts) {
      if (attemptIds.has(attempt.attemptId)) {
        throw new ExecutionBundleValidationError(
          'EXECUTION_BUNDLE_IDENTITY_MISMATCH',
          'ExecutionBundle contains a duplicate ExecutionAttempt identity.',
        );
      }
      attemptIds.add(attempt.attemptId);
    }
  }
}

export function assertExecutionRecordAttemptSemantics(
  record: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>,
): void {
  for (let index = 0; index < record.attempts.length; index += 1) {
    const attempt = record.attempts[index];
    const expectedNumber = index + 1;
    if (attempt.attemptNumber !== expectedNumber) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID',
        'Execution attempts must be ordered consecutively from one.',
      );
    }
    const expectedAttemptId = deriveAttemptId({
      trialId: record.trialId as Sha256Digest,
      attemptNumber: expectedNumber,
    });
    if (attempt.attemptId !== expectedAttemptId) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_IDENTITY_MISMATCH',
        'ExecutionAttempt identity does not match its trial and attempt number.',
      );
    }
    if (index < record.attempts.length - 1 && attempt.attemptStatus === 'completed') {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID',
        'A completed ExecutionAttempt must terminate its trial.',
      );
    }
  }
  if (record.attempts.at(-1)?.attemptStatus !== record.executionStatus) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID',
      'The final attempt status must match the active ExecutionRecord status.',
    );
  }
}

function assertSchedulingBlockAtomicity(records: readonly ExecutionRecord[]): void {
  const blocks = new Map<string, {
    trialIndex: number;
    hasActive: boolean;
    hasCensored: boolean;
  }>();
  for (const record of records) {
    const block = blocks.get(record.schedulingBlockId) ?? {
      trialIndex: record.trialIndex,
      hasActive: false,
      hasCensored: false,
    };
    if (block.trialIndex !== record.trialIndex) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_IDENTITY_MISMATCH',
        'A scheduling block cannot span multiple trial indices.',
      );
    }
    if (record.executionStatus === 'budget-censored') block.hasCensored = true;
    else block.hasActive = true;
    blocks.set(record.schedulingBlockId, block);
  }
  if ([...blocks.values()].some((block) => block.hasActive && block.hasCensored)) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_BLOCK_ATOMICITY_INVALID',
      'A scheduling block cannot mix active and budget-censored coordinates.',
    );
  }
}

function expectedBudgetOutcome(attempt: ExecutionAttempt): 'completed' | 'failed' | 'cancelled' | 'attempt-timeout' {
  if (attempt.attemptStatus === 'completed') return 'completed';
  if (attempt.attemptStatus === 'cancelled') return 'cancelled';
  return attempt.error.code === 'timeout' ? 'attempt-timeout' : 'failed';
}

function assertBudgetLedgerMatchesRecords(bundle: ExecutionBundle): void {
  const entries = new Map(bundle.budgetSummary.entries.map((entry) => [entry.attemptId, entry]));
  let expectedEntries = 0;
  for (const record of bundle.records) {
    if (record.executionStatus === 'budget-censored'
        || (record.cache.cacheStatus !== 'miss'
          && record.cache.cacheStatus !== 'not-used')) continue;
    for (const attempt of record.attempts) {
      expectedEntries += 1;
      const entry = entries.get(attempt.attemptId);
      if (entry === undefined
          || entry.stage !== 'execution'
          || entry.coordinateId !== record.trialId
          || entry.activeDurationMs !== attempt.timing.durationMs
          || entry.outcomeKind !== expectedBudgetOutcome(attempt)
          || canonicalizeJson(entry.providerCost ?? null)
            !== canonicalizeJson(attempt.usage?.providerCost ?? null)) {
        throw new ExecutionBundleValidationError(
          'EXECUTION_BUNDLE_BUDGET_SUMMARY_INVALID',
          'Execution budget ledger must exactly account for every current native attempt.',
        );
      }
    }
  }
  if (entries.size !== expectedEntries) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_BUDGET_SUMMARY_INVALID',
      'Execution budget ledger contains an attempt absent from current native records.',
    );
  }
}

function assertCoverage(bundle: ExecutionBundle): void {
  const { coverage } = bundle;
  if (coverage.planned === 0
      || coverage.started !== coverage.succeeded + coverage.failed + coverage.cancelled
      || coverage.planned !== coverage.started + coverage.budgetCensored + coverage.notStarted
      || bundle.records.length !== coverage.started + coverage.budgetCensored) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_COVERAGE_INVALID',
      'ExecutionBundle coverage counters are not internally consistent.',
    );
  }
  const actual = {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    budgetCensored: 0,
  };
  for (const record of bundle.records) {
    if (record.executionStatus === 'completed') actual.succeeded += 1;
    else if (record.executionStatus === 'failed') actual.failed += 1;
    else if (record.executionStatus === 'cancelled') actual.cancelled += 1;
    else actual.budgetCensored += 1;
  }
  if (actual.succeeded !== coverage.succeeded
      || actual.failed !== coverage.failed
      || actual.cancelled !== coverage.cancelled
      || actual.budgetCensored !== coverage.budgetCensored) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_COVERAGE_INVALID',
      'ExecutionBundle coverage counters do not match its records.',
    );
  }
}

function assertStatus(bundle: ExecutionBundle): void {
  const { executionBundleStatus: status, coverage, terminationReasonCode } = bundle;
  if (status === 'completed') {
    if (terminationReasonCode !== undefined
        || coverage.notStarted !== 0
        || coverage.budgetCensored !== 0) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_STATUS_INVALID',
        'A completed ExecutionBundle must cover every planned coordinate.',
      );
    }
    return;
  }
  if (terminationReasonCode === undefined) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_STATUS_INVALID',
      'A non-completed ExecutionBundle requires a termination reason code.',
    );
  }
  if (status === 'budget-exhausted'
      && coverage.notStarted !== 0) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_STATUS_INVALID',
      'A budget-exhausted ExecutionBundle must classify every unstarted coordinate as budget-censored; exhaustion during a started trial may leave no censored coordinate.',
    );
  }
  if (status === 'cancelled'
      && coverage.cancelled + coverage.notStarted === 0
      && coverage.started !== coverage.planned) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_STATUS_INVALID',
      'A cancelled ExecutionBundle must expose cancelled or unstarted coordinates.',
    );
  }
  // A run-level infrastructure or teardown failure can happen after every
  // coordinate has completed, so terminationReasonCode is the authoritative
  // failed-state fact rather than record coverage alone.
}

function isInline(content: CapturedContent | undefined): boolean {
  return content?.contentKind === 'inline';
}

function isResolvable(content: CapturedContent | undefined): boolean {
  return content?.contentKind === 'inline' || content?.contentKind === 'descriptor';
}

function assertReplayability(bundle: ExecutionBundle): void {
  if (bundle.replayability === 'summary-only') return;
  const active = bundle.records.filter(
    (record) => record.executionStatus !== 'budget-censored',
  );
  const completed = bundle.records.filter(
    (record) => record.executionStatus === 'completed',
  );
  if (completed.length === 0) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_REPLAYABILITY_INVALID',
      'A replayable ExecutionBundle requires at least one completed execution.',
    );
  }
  if (bundle.replayability === 'self-contained') {
    if (completed.some((record) => !isInline(record.output)
      || (record.trace !== undefined && !isInline(record.trace)))
      || active.some((record) => record.executionStatus !== 'completed'
        && record.trace !== undefined
        && !isInline(record.trace))) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_REPLAYABILITY_INVALID',
        'A self-contained ExecutionBundle requires inline completed outputs and traces.',
      );
    }
    return;
  }
  const contents = active.flatMap((record) => (
    record.executionStatus === 'completed'
      ? [record.output, record.trace]
      : [record.trace]
  ))
    .filter((content): content is CapturedContent => content !== undefined);
  if (completed.some((record) => !isResolvable(record.output)
      || (record.trace !== undefined && !isResolvable(record.trace)))
      || active.some((record) => record.executionStatus !== 'completed'
        && record.trace !== undefined
        && !isResolvable(record.trace))
      || !contents.some((content) => content.contentKind === 'descriptor')) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_REPLAYABILITY_INVALID',
      'A resolvable ExecutionBundle requires inline or descriptor content and a descriptor.',
    );
  }
}

export function assertExecutionBundleSemantics(bundle: ExecutionBundle): void {
  assertCanonicalRecordOrder(bundle.records);
  assertRecordIdentities(bundle);
  assertSchedulingBlockAtomicity(bundle.records);
  assertCoverage(bundle);
  assertStatus(bundle);
  assertReplayability(bundle);
  if (bundle.budgetSummary.runContractDigest !== bundle.runContractDigest
      || bundle.budgetSummary.entries.some((entry) => entry.stage !== 'execution')) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_BUDGET_SUMMARY_INVALID',
      'ExecutionBundle budget summary must bind the Run and contain only execution entries.',
    );
  }
  for (const record of bundle.records) {
    if (record.executionStatus !== 'budget-censored'
        && !executionRecordUsageMatchesAttempts(record)) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_USAGE_INVALID',
        'ExecutionRecord usage does not match its attempt facts.',
      );
    }
  }
  if (canonicalizeJson(bundle.provenance.parentDigests)
      !== canonicalizeJson([bundle.runContractDigest, bundle.executionPlanDigest])) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_PLAN_MISMATCH',
      'ExecutionBundle provenance must bind its originating RunPlan and ExecutionPlan.',
    );
  }
}

export interface ExecutionBundlePlanContext extends ExecutionIdentityPlanContext {
  execution: ExecutionIdentityPlanContext['execution'] & {
    executionInputDigest: string;
    runtimes: readonly {
      runtimeKind: 'executor' | 'evaluator' | 'analysis-node' | 'missing-policy' | 'decision-policy';
      referenceId: string;
      identity: ExecutionRuntimeIdentity;
    }[];
    policy: {
      executionCacheMode: 'disabled' | 'replay-only' | 'transparent-deterministic';
      retry: {
        maxAttempts: number;
        retryableErrorCodes: readonly string[];
      };
      budget: {
        run: {
          maxInvocations?: number;
          maxProviderCost?: { amount: number; currency: string };
          maxActiveDurationMs?: number;
          maxWallClockMs?: number;
        };
        stages: {
          execution: {
            maxInvocations?: number;
            maxProviderCost?: { amount: number; currency: string };
            maxActiveDurationMs?: number;
          };
          evaluation: {
            maxInvocations?: number;
            maxProviderCost?: { amount: number; currency: string };
            maxActiveDurationMs?: number;
          };
        };
        coordinate: {
          maxInvocations?: number;
          maxProviderCost?: { amount: number; currency: string };
          maxActiveDurationMs?: number;
        };
        attempt: {
          maxProviderCost?: { amount: number; currency: string };
        };
        providerCostAdmission: {
          admissionMode: 'strict-reservation' | 'bounded-overshoot';
          unknownCostMode: 'fail-run' | 'mark-unverifiable';
        };
      };
      evidence: {
        output: 'full' | 'reference' | 'digest' | 'none';
        trace: 'full' | 'reference' | 'digest' | 'none';
        maximumClassification: 'public' | 'sensitive' | 'secret' | 'gold';
      };
    };
  };
  digests: {
    datasetRevisionDigest: string;
    executionInputDigest: string;
    executionPlanDigest: string;
    runContractDigest: string;
  };
}

type DeepReadonlyValue<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonlyValue<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonlyValue<T[Key]> }
    : T;

type ExecutionRuntimeIdentity = DeepReadonlyValue<RuntimeIdentity>;

export interface ExecutionBundleVerificationContext {
  /** Independently verified by a trusted cache boundary, never derived from the Bundle claim. */
  readonly verifiedCacheRecordDigests?: ReadonlySet<Sha256Digest>;
  /** Independently attested by the producing Runtime or a host trust verifier. */
  readonly verifiedProvenanceBundleDigests?: ReadonlySet<Sha256Digest>;
}

export interface ExecutionBundlePlanVerification {
  readonly provenanceTrustStatus: 'verified' | 'indeterminate';
  readonly cacheReceiptStatus: 'verified' | 'indeterminate';
  readonly invocationBudgetStatus: 'verified' | 'indeterminate';
  readonly providerCostBudgetStatus: 'verified' | 'indeterminate';
  readonly minimumTargetInvocations: number;
  readonly maximumTargetInvocations: number;
  readonly minimumProviderCost?: { readonly amount: number; readonly currency: string };
  readonly maximumProviderCost?: { readonly amount: number; readonly currency: string };
  readonly unverifiedCacheRecordDigests: readonly Sha256Digest[];
}

export interface ExecutionBundleVerificationResult {
  readonly bundle: ExecutionBundle;
  readonly planVerification: ExecutionBundlePlanVerification;
}

export type ExecutionBundleSource = ExecutionBundleVerificationResult;

const executionBundleSources = new WeakSet<object>();

export function assertExecutionBundleSource(
  value: unknown,
): asserts value is ExecutionBundleSource {
  if (value === null || typeof value !== 'object' || !executionBundleSources.has(value)) {
    throw new TypeError(
      'Execution stage requires a source returned by parseExecutionBundle() or the Runtime.',
    );
  }
}

export function assertExecutionBundleSourceMatchesPlan(
  source: ExecutionBundleSource,
  plan: ExecutionBundlePlanContext,
): void {
  assertExecutionBundleSource(source);
  if (source.bundle.executionPlanDigest !== plan.execution.executionPlanDigest
      || source.bundle.executionPlanDigest !== plan.digests.executionPlanDigest
      || source.bundle.executionInputDigest !== plan.execution.executionInputDigest
      || source.bundle.executionInputDigest !== plan.digests.executionInputDigest) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_PLAN_MISMATCH',
      'Execution source does not match the current ExecutionPlan.',
    );
  }
}

export function effectiveExecutionBundleTrust(
  source: ExecutionBundleSource,
): Provenance['trust'] {
  assertExecutionBundleSource(source);
  if (source.planVerification.provenanceTrustStatus === 'verified') {
    return source.bundle.provenance.trust;
  }
  return source.bundle.provenance.trust === 'untrusted' ? 'untrusted' : 'unknown';
}

const TRUST_LEVEL = { untrusted: 0, unknown: 1, declared: 2, verified: 3 } as const;

function minimumTrust(
  ...values: readonly Provenance['trust'][]
): Provenance['trust'] {
  return values.reduce((minimum, value) => (
    TRUST_LEVEL[value] < TRUST_LEVEL[minimum] ? value : minimum
  ), 'verified');
}

function assertTrustAtMost(
  actual: Provenance['trust'],
  ceiling: Provenance['trust'],
  message: string,
): void {
  if (TRUST_LEVEL[actual] > TRUST_LEVEL[ceiling]) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_PROVENANCE_INVALID',
      message,
    );
  }
}

const CLASSIFICATION_LEVEL = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;

type ExecutionEvidencePolicy = ExecutionBundlePlanContext['execution']['policy']['evidence'];

function capturedContentMatchesPolicy(
  content: CapturedContent | undefined,
  mode: ExecutionEvidencePolicy['output'],
  maximumClassification: ExecutionEvidencePolicy['maximumClassification'],
): boolean {
  if (content === undefined) return true;
  if (mode === 'none'
      || CLASSIFICATION_LEVEL[content.classification]
        > CLASSIFICATION_LEVEL[maximumClassification]) return false;
  const expectedKind = mode === 'full'
    ? 'inline'
    : mode === 'reference'
      ? 'descriptor'
      : 'digest-only';
  return content.contentKind === expectedKind;
}

export function executionRecordMatchesEvidencePolicy(
  record: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>,
  policy: ExecutionEvidencePolicy,
): boolean {
  return capturedContentMatchesPolicy(record.trace, policy.trace, policy.maximumClassification)
    && (record.executionStatus !== 'completed'
      || capturedContentMatchesPolicy(
        record.output,
        policy.output,
        policy.maximumClassification,
      ));
}

export function aggregateExecutionAttemptUsage(
  attempts: readonly ExecutionAttempt[],
): UsageRecord | undefined {
  const values = attempts.map((attempt) => attempt.usage);
  const reported = values.filter((usage): usage is UsageRecord => usage !== undefined);
  if (reported.length === 0) return undefined;
  if (values.length === 1) return reported[0];
  const costs = reported.flatMap((usage) => (
    usage.providerCost === undefined ? [] : [usage.providerCost]
  ));
  const currencies = new Set(costs.map((cost) => cost.currency));
  const providerCost = costs.length === values.length && currencies.size === 1
    ? {
      amount: costs.reduce((sum, cost) => sum + cost.amount, 0),
      currency: costs[0].currency,
      reportedByProvider: true as const,
    }
    : undefined;
  return {
    ...(reported.some((usage) => usage.inputTokens !== undefined)
      ? { inputTokens: reported.reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0) }
      : {}),
    ...(reported.some((usage) => usage.outputTokens !== undefined)
      ? { outputTokens: reported.reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0) }
      : {}),
    ...(reported.some((usage) => usage.totalTokens !== undefined)
      ? { totalTokens: reported.reduce((sum, usage) => sum + (usage.totalTokens ?? 0), 0) }
      : {}),
    ...(providerCost !== undefined ? { providerCost } : {}),
    details: {
      aggregationKind: 'omk.execution-usage-summary/v1',
      attemptCount: values.length,
      reportedAttemptCount: reported.length,
      providerCostAggregation: costs.length === 0
        ? 'unreported'
        : costs.length !== values.length
          ? 'partial'
          : currencies.size === 1
            ? 'summed'
            : 'mixed-currency',
    },
  };
}

export function executionRecordUsageMatchesAttempts(
  record: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>,
): boolean {
  return canonicalizeJson(record.usage ?? null)
    === canonicalizeJson(aggregateExecutionAttemptUsage(record.attempts) ?? null);
}

export function assertExecutionRecordMatchesAttemptPolicy(
  record: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>,
  policy: ExecutionBundlePlanContext['execution']['policy']['retry'],
): void {
  assertExecutionRecordAttemptSemantics(record);
  if (record.attempts.length > policy.maxAttempts
      || record.attempts.slice(0, -1).some((attempt) => (
        attempt.attemptStatus !== 'failed'
        || !policy.retryableErrorCodes.includes(attempt.error.code)
      ))) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_RETRY_POLICY_INVALID',
      'ExecutionRecord attempts do not satisfy the sealed retry policy.',
    );
  }
}

export function executionRecordSatisfiesCacheCostPolicy(
  record: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>,
  maximum: { amount: number; currency: string } | undefined,
): boolean {
  if (maximum === undefined) return true;
  const amount = executionRecordProviderCost(record, maximum.currency);
  return amount !== undefined && amount < maximum.amount;
}

function executionRecordProviderCost(
  record: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>,
  currency: string,
): number | undefined {
  let amount = 0;
  for (const attempt of record.attempts) {
    const cost = attempt.usage?.providerCost;
    if (cost === undefined || cost.currency !== currency) return undefined;
    amount += cost.amount;
  }
  return amount;
}

function coordinateKey(
  coordinate: Pick<PlannedExecutionCoordinate, 'targetId' | 'sampleId' | 'trialIndex'>,
): string {
  return canonicalizeJson([
    coordinate.targetId,
    coordinate.sampleId,
    coordinate.trialIndex,
  ]);
}

function planMismatch(message: string): never {
  throw new ExecutionBundleValidationError('EXECUTION_BUNDLE_PLAN_MISMATCH', message);
}

function executionCacheKey(
  plan: ExecutionBundlePlanContext,
  coordinate: PlannedExecutionCoordinate,
): Sha256Digest {
  return digestCanonicalJson({
    derivation: 'omk.execution-cache-key/v1',
    executionPlanDigest: plan.execution.executionPlanDigest,
    trialId: coordinate.trialId,
  });
}

function assertExecutionCachePolicy(
  record: Exclude<ExecutionRecord, { executionStatus: 'budget-censored' }>,
  plan: ExecutionBundlePlanContext,
  expected: PlannedExecutionCoordinate,
  runtime: ExecutionRuntimeIdentity,
): boolean {
  const { cache, provenance } = record;
  const noDigests = cache.cacheKeyDigest === undefined
    && cache.sourceRecordDigest === undefined;
  const mode = plan.execution.policy.executionCacheMode;
  assertTrustAtMost(
    provenance.trust,
    runtime.assuranceLevel,
    'ExecutionRecord trust exceeds its sealed Executor Runtime assurance.',
  );
  if (mode === 'disabled') {
    if (cache.cacheStatus !== 'not-used'
        || !noDigests
        || provenance.provenanceKind === 'replay') {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_CACHE_POLICY_INVALID',
        'ExecutionRecord cache facts contradict the sealed disabled cache policy.',
      );
    }
    return false;
  }

  const expectedCacheKey = executionCacheKey(plan, expected);
  if (mode === 'transparent-deterministic'
      && cache.cacheStatus === 'miss'
      && cache.cacheKeyDigest === expectedCacheKey
      && cache.sourceRecordDigest === undefined
      && provenance.provenanceKind !== 'replay'
      && provenance.parentDigests.includes(plan.execution.executionPlanDigest)) {
    return false;
  }

  const expectedHitStatus = mode === 'replay-only' ? 'replay' : 'transparent-hit';
  if (cache.cacheStatus === expectedHitStatus
      && record.executionStatus === 'completed'
      && cache.cacheKeyDigest === expectedCacheKey
      && cache.sourceRecordDigest !== undefined
      && canonicalizeJson(provenance) === canonicalizeJson({
        provenanceKind: 'replay',
        trust: provenance.trust,
        sourceId: record.trialId,
        parentDigests: [cache.sourceRecordDigest],
      })) {
    const nativeRecord = {
      ...record,
      provenance: {
        provenanceKind: 'native' as const,
        trust: provenance.trust,
        parentDigests: [plan.execution.executionPlanDigest],
      },
      cache: {
        cacheStatus: 'miss' as const,
        cacheKeyDigest: expectedCacheKey,
      },
    };
    if (digestCanonicalJson(nativeRecord) === cache.sourceRecordDigest
        && executionRecordSatisfiesCacheCostPolicy(
          record,
          plan.execution.policy.budget.stages.execution.maxProviderCost
            ?? plan.execution.policy.budget.run.maxProviderCost,
        )) return true;
  }

  throw new ExecutionBundleValidationError(
    'EXECUTION_BUNDLE_CACHE_POLICY_INVALID',
    'ExecutionRecord cache facts do not satisfy the sealed reuse policy.',
  );
}

export function assertExecutionBundleMatchesPlan(
  bundle: ExecutionBundle,
  plan: ExecutionBundlePlanContext,
  verification?: ExecutionBundleVerificationContext,
): ExecutionBundlePlanVerification {
  if (!budgetSummaryMatchesPolicy(bundle.budgetSummary, plan.execution.policy.budget)) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_BUDGET_SUMMARY_INVALID',
      'ExecutionBundle budget summary does not match the sealed budget policy.',
    );
  }
  if (bundle.executionPlanDigest !== plan.digests.executionPlanDigest
      || bundle.executionPlanDigest !== plan.execution.executionPlanDigest
      || bundle.executionInputDigest !== plan.digests.executionInputDigest
      || bundle.executionInputDigest !== plan.execution.executionInputDigest) {
    planMismatch('ExecutionBundle execution-stage digests do not match the sealed RunPlan.');
  }

  const planned = derivePlannedExecutionCoordinates(plan);
  if (bundle.coverage.planned !== planned.length) {
    planMismatch('ExecutionBundle planned coverage does not match the sealed coordinate universe.');
  }
  const plannedByCoordinate = new Map(
    planned.map((coordinate) => [coordinateKey(coordinate), coordinate]),
  );
  const recordsByCoordinate = new Map(
    bundle.records.map((record) => [coordinateKey(record), record]),
  );
  const runtimesByTarget = new Map<string, ExecutionRuntimeIdentity>();
  for (const runtime of plan.execution.runtimes) {
    if (runtime.runtimeKind !== 'executor') continue;
    if (runtimesByTarget.has(runtime.referenceId)) {
      planMismatch('ExecutionPlan contains duplicate executor Runtime bindings.');
    }
    runtimesByTarget.set(runtime.referenceId, runtime.identity);
  }

  let minimumTargetInvocations = 0;
  let maximumTargetInvocations = 0;
  let minimumProviderCostAmount = 0;
  let maximumProviderCostAmount = 0;
  let providerCostUpperBoundKnown = true;
  const unverifiedCacheRecordDigests: Sha256Digest[] = [];
  const providerCostBudget = plan.execution.policy.budget.stages.execution.maxProviderCost
    ?? plan.execution.policy.budget.run.maxProviderCost;
  for (const record of bundle.records) {
    const expected = plannedByCoordinate.get(coordinateKey(record));
    if (expected === undefined) {
      planMismatch('ExecutionBundle contains a coordinate outside the sealed ExecutionPlan.');
    }
    if (record.trialId !== expected.trialId
        || record.randomizationSlotId !== expected.randomizationSlotId
        || record.trialSeed !== expected.trialSeed
        || record.schedulingBlockId !== expected.schedulingBlockId
        || canonicalizeJson(record.samplingUnitIds)
          !== canonicalizeJson(expected.samplingUnitIds)) {
      planMismatch('ExecutionRecord identities do not match their sealed derivation.');
    }
    const runtime = runtimesByTarget.get(record.targetId);
    if (runtime === undefined
        || canonicalizeJson(record.runtime) !== canonicalizeJson(runtime)) {
      planMismatch('ExecutionRecord Runtime does not match its sealed Target binding.');
    }
    if (record.executionStatus === 'budget-censored') continue;
    assertExecutionRecordMatchesAttemptPolicy(record, plan.execution.policy.retry);
    if (!executionRecordMatchesEvidencePolicy(record, plan.execution.policy.evidence)) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_EVIDENCE_POLICY_INVALID',
        'ExecutionRecord evidence contradicts the sealed capture or classification policy.',
      );
    }
    const cacheHit = assertExecutionCachePolicy(record, plan, expected, runtime);
    const sourceRecordDigest = record.cache.sourceRecordDigest as Sha256Digest | undefined;
    const verifiedCacheHit = cacheHit
      && sourceRecordDigest !== undefined
      && verification?.verifiedCacheRecordDigests?.has(sourceRecordDigest) === true;
    if (!cacheHit) {
      minimumTargetInvocations += record.attempts.length;
      maximumTargetInvocations += record.attempts.length;
    } else if (!verifiedCacheHit) {
      maximumTargetInvocations += record.attempts.length;
      unverifiedCacheRecordDigests.push(sourceRecordDigest as Sha256Digest);
    }

    if (providerCostBudget !== undefined) {
      const amount = executionRecordProviderCost(record, providerCostBudget.currency);
      if (amount === undefined) {
        if (bundle.executionBundleStatus === 'completed'
            && plan.execution.policy.budget.providerCostAdmission.unknownCostMode
              === 'fail-run') {
          throw new ExecutionBundleValidationError(
            'EXECUTION_BUNDLE_PROVIDER_COST_INVALID',
            'A completed ExecutionBundle must report sealed-currency provider cost for every native invocation.',
          );
        }
        if (!cacheHit) providerCostUpperBoundKnown = false;
      } else if (!cacheHit) {
        minimumProviderCostAmount += amount;
        maximumProviderCostAmount += amount;
      } else if (!verifiedCacheHit) {
        maximumProviderCostAmount += amount;
      }
    }
  }
  assertTrustAtMost(
    bundle.provenance.trust,
    minimumTrust(...bundle.records.map((record) => record.provenance.trust)),
    'ExecutionBundle trust exceeds its record provenance.',
  );
  const maxInvocations = plan.execution.policy.budget.stages.execution.maxInvocations
    ?? plan.execution.policy.budget.run.maxInvocations;
  if (maxInvocations !== undefined && minimumTargetInvocations > maxInvocations) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_RETRY_POLICY_INVALID',
      'ExecutionBundle exceeds the sealed target invocation budget.',
    );
  }
  if (providerCostBudget !== undefined
      && bundle.executionBundleStatus === 'completed'
      && minimumProviderCostAmount >= providerCostBudget.amount) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_PROVIDER_COST_INVALID',
      'A completed ExecutionBundle cannot exhaust the sealed provider-cost budget.',
    );
  }
  if (providerCostBudget !== undefined
      && bundle.terminationReasonCode?.endsWith('provider-cost-budget-exhausted') === true
      && (!providerCostUpperBoundKnown
        || minimumProviderCostAmount < providerCostBudget.amount)) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_PROVIDER_COST_INVALID',
      'Provider-cost exhaustion requires enough reported native invocation cost.',
    );
  }

  const plannedByBlock = new Map<string, PlannedExecutionCoordinate[]>();
  for (const coordinate of planned) {
    const block = plannedByBlock.get(coordinate.schedulingBlockId) ?? [];
    block.push(coordinate);
    plannedByBlock.set(coordinate.schedulingBlockId, block);
  }
  for (const record of bundle.records) {
    if (record.executionStatus !== 'budget-censored') continue;
    const block = plannedByBlock.get(record.schedulingBlockId);
    if (block === undefined || block.some((coordinate) => (
      recordsByCoordinate.get(coordinateKey(coordinate))?.executionStatus
        !== 'budget-censored'
    ))) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_BLOCK_ATOMICITY_INVALID',
        'Every coordinate in a budget-censored scheduling block must be censored together.',
      );
    }
  }
  const providerCostBudgetStatus = providerCostBudget === undefined
    || minimumProviderCostAmount >= providerCostBudget.amount
    || (providerCostUpperBoundKnown
      && maximumProviderCostAmount < providerCostBudget.amount)
    ? 'verified'
    : 'indeterminate';
  assertBudgetLedgerMatchesRecords(bundle);
  return {
    provenanceTrustStatus: verification?.verifiedProvenanceBundleDigests?.has(
      bundle.bundleDigest as Sha256Digest,
    ) === true
      ? 'verified'
      : 'indeterminate',
    cacheReceiptStatus: unverifiedCacheRecordDigests.length === 0
      ? 'verified'
      : 'indeterminate',
    invocationBudgetStatus: maxInvocations === undefined
        || maximumTargetInvocations <= maxInvocations
      ? 'verified'
      : 'indeterminate',
    providerCostBudgetStatus,
    minimumTargetInvocations,
    maximumTargetInvocations,
    ...(providerCostBudget === undefined
      ? {}
      : {
        minimumProviderCost: {
          amount: minimumProviderCostAmount,
          currency: providerCostBudget.currency,
        },
        ...(providerCostUpperBoundKnown
          ? {
            maximumProviderCost: {
              amount: maximumProviderCostAmount,
              currency: providerCostBudget.currency,
            },
          }
          : {}),
      }),
    unverifiedCacheRecordDigests,
  };
}

export function parseExecutionBundleDocument(value: unknown): ExecutionBundle {
  const bundle = parseWireDocument(ExecutionBundleSchema, value);
  assertExecutionBundleSemantics(bundle);
  if (digestArtifactPayload(bundle, 'bundleDigest') !== bundle.bundleDigest) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_DIGEST_MISMATCH',
      'ExecutionBundle digest does not match its canonical payload.',
    );
  }
  return bundle;
}

export function parseExecutionBundle(
  value: unknown,
  plan: ExecutionBundlePlanContext,
): ExecutionBundleSource {
  return verifyExecutionBundle(value, plan);
}

export function verifyExecutionBundle(
  value: unknown,
  plan: ExecutionBundlePlanContext,
  verification?: ExecutionBundleVerificationContext,
): ExecutionBundleVerificationResult {
  const bundle = parseExecutionBundleDocument(value);
  const planVerification = assertExecutionBundleMatchesPlan(bundle, plan, verification);
  const source = { bundle, planVerification };
  executionBundleSources.add(source);
  return deepFreezeCanonicalJson(source);
}
