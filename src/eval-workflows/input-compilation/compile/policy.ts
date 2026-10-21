import { compareStrings } from '../../../eval-core/primitives/ordering.js';
import { EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION, MEASUREMENT_POLICY_SCHEMA_VERSION, MeasurementPolicySchema, createEvaluationSeriesDefinition, deepFreezeCanonicalJson, digestCanonicalJson, parseWireDocument, type MeasurementPolicy, type Sha256Digest } from '../../../eval-core/contracts/index.js';
import { type CompiledIndependentSeries, type ResolvedCliEvaluationInput } from '../types.js';
import { fail, canonicalSnapshot } from './values.js';

export function compilePolicy(input: ResolvedCliEvaluationInput): MeasurementPolicy {
  const policyInput = input.policy;
  if (!Number.isInteger(policyInput.retryCount) || policyInput.retryCount < 0) fail({
    code: 'CLI_INPUT_INVALID',
    fieldPath: 'policy.retryCount',
    message: 'retryCount 必须是非负整数。',
  });
  const retry = {
    maxAttempts: policyInput.retryCount + 1,
    retryableErrorCodes: [...(policyInput.retryableErrorCodes ?? ['timeout', 'transport-error'])]
      .sort(compareStrings),
    backoff: { backoffKind: 'none' as const, initialDelayMs: 0 },
  };
  const budget = policyInput.budget;
  const cost = (amount: number | undefined): { amount: number; currency: string } | undefined => (
    amount === undefined ? undefined : { amount, currency: 'USD' }
  );
  const raw = canonicalSnapshot({
    schemaVersion: MEASUREMENT_POLICY_SCHEMA_VERSION,
    execution: {
      maxConcurrency: policyInput.executionConcurrency,
      ...(policyInput.executionTimeoutMs === undefined ? {} : { timeoutMs: policyInput.executionTimeoutMs }),
    },
    retry,
    budget: {
      run: {
        ...(budget?.runMaxInvocations === undefined ? {} : { maxInvocations: budget.runMaxInvocations }),
        ...(budget?.totalProviderCostUSD === undefined ? {} : {
          maxProviderCost: cost(budget.totalProviderCostUSD),
        }),
      },
      stages: {
        execution: budget?.executionMaxInvocations === undefined
          ? {}
          : { maxInvocations: budget.executionMaxInvocations },
        evaluation: budget?.evaluationMaxInvocations === undefined
          ? {}
          : { maxInvocations: budget.evaluationMaxInvocations },
      },
      coordinate: {
        ...(budget?.perCoordinateProviderCostUSD === undefined ? {} : {
          maxProviderCost: cost(budget.perCoordinateProviderCostUSD),
        }),
        ...(budget?.perCoordinateActiveDurationMs === undefined ? {} : {
          maxActiveDurationMs: budget.perCoordinateActiveDurationMs,
        }),
      },
      attempt: {},
      providerCostAdmission: {
        admissionMode: 'bounded-overshoot',
        unknownCostMode: 'fail-run',
      },
    },
    evaluation: {
      maxConcurrency: policyInput.evaluationConcurrency ?? policyInput.executionConcurrency,
      ...(policyInput.evaluationTimeoutMs === undefined ? {} : { timeoutMs: policyInput.evaluationTimeoutMs }),
      retry,
    },
    cache: policyInput.cache,
    evidence: policyInput.evidence ?? {
      output: 'full',
      trace: 'reference',
      evidence: 'full',
      maximumClassification: 'gold',
    },
    failure: policyInput.failure ?? { failureMode: 'continue' },
    eventDelivery: policyInput.eventDelivery ?? {
      writerMode: 'disabled',
      backpressureMode: 'block',
      writerFailureMode: 'ignore',
    },
  });
  try {
    return deepFreezeCanonicalJson(parseWireDocument(MeasurementPolicySchema, raw));
  } catch (cause) {
    fail({
      code: 'CLI_INPUT_CORE_SCHEMA_INVALID',
      fieldPath: 'policy',
      message: '编译后的 MeasurementPolicy 不符合 Core schema。',
      cause,
    });
  }
}

export function compileSeries(
  input: ResolvedCliEvaluationInput,
  designDigest: Sha256Digest,
): CompiledIndependentSeries | undefined {
  const series = input.orchestration.independentSeries;
  if (series === undefined || series.repeatCount === 1) return undefined;
  if (!Number.isInteger(series.repeatCount) || series.repeatCount < 1) fail({
    code: 'CLI_INPUT_SERIES_INVALID',
    fieldPath: 'orchestration.independentSeries.repeatCount',
    message: '独立 Run repeat 数量必须是正整数。',
  });
  if (!series.seriesInstanceId || series.seriesInstanceId.length > 192) fail({
    code: 'CLI_INPUT_SERIES_INVALID',
    fieldPath: 'orchestration.independentSeries.seriesInstanceId',
    message: '独立 Series 必须由 orchestrator 提供不超过 192 字符的实例标识。',
  });
  const seriesDesignIdentity = digestCanonicalJson({
    measurementDesignDigest: designDigest,
    repeatCount: series.repeatCount,
    comparisonScope: series.comparisonScope ?? 'analysis',
    minimumStatus: series.minimumStatus ?? 'conditional',
  });
  const seriesId = `${series.seriesInstanceId}-${seriesDesignIdentity.slice(
    'sha256:'.length,
    'sha256:'.length + 16,
  )}`;
  const members = Array.from({ length: series.repeatCount }, (_, replicateIndex) => ({
    memberId: `${seriesId}-member-${replicateIndex}`,
    replicateIndex,
  }));
  try {
    const definition = createEvaluationSeriesDefinition({
      schemaVersion: EVALUATION_SERIES_DEFINITION_SCHEMA_VERSION,
      seriesId,
      analysisMode: 'preregistered',
      experimentalUnit: 'run',
      members,
      comparabilityPolicy: {
        designMode: 'exact-measurement-design',
        comparisonScope: series.comparisonScope ?? 'analysis',
        minimumStatus: series.minimumStatus ?? 'conditional',
      },
      analysisGraph: {
        nodes: [{
          nodeId: 'run-variance',
          implementationId: 'omk.series.variance/v1',
          analysisStandardId: 'omk.series.variance/v1',
          minimumMemberEvidenceStatus: 'partial',
          inputs: [{ seriesInputKind: 'members', referenceId: seriesId }],
          outputResultId: 'run-variance',
          parameters: { estimator: 'sample-variance', minimumMembers: 2 },
        }],
      },
    });
    return deepFreezeCanonicalJson({
      definition,
      memberships: members.map((member) => ({
        seriesDesignDigest: definition.seriesDesignDigest,
        memberId: member.memberId,
        replicateIndex: member.replicateIndex,
      })),
    });
  } catch (cause) {
    fail({
      code: 'CLI_INPUT_SERIES_INVALID',
      fieldPath: 'orchestration.independentSeries',
      message: '独立 Run repeat 无法编译为 Evaluation Series contract。',
      cause,
    });
  }
}
