import {
  AnalysisBundleSchema,
  type AnalysisBundle,
  type AnalysisObservationCoverage,
  type AnalysisRecord,
  type EvaluationBundle,
  type ExecutionBundle,
} from './artifacts.js';
import {
  SchemaIdentitySchema,
  schemaIdentityKey,
  type CoreSchemaValidator,
  type Provenance,
} from './common.js';
import { analysisComparisonAppliesToMetricInput } from './analysis-input-matching.js';
import { derivePlannedEvaluationCoordinates } from './evaluation-identities.js';
import {
  countAnalysisResamplingUnits,
} from './analysis-identities.js';
import { derivePlannedExecutionCoordinates } from './execution-identities.js';
import {
  assertEvaluationBundleSourceChain,
  assertEvaluationBundleSourceMatchesPlan,
  effectiveEvaluationBundleTrust,
  type EvaluationBundlePlanContext,
  type EvaluationBundleSource,
} from './evaluation-bundle.js';
import { digestArtifactPayload } from './digests.js';
import type { ExecutionBundleSource } from './execution-bundle.js';
import {
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  parseWireDocument,
  type Sha256Digest,
} from './json.js';

export type AnalysisBundleValidationErrorCode =
  | 'ANALYSIS_BUNDLE_DUPLICATE_RECORD'
  | 'ANALYSIS_BUNDLE_RECORD_ORDER_INVALID'
  | 'ANALYSIS_BUNDLE_RECORD_DIGEST_MISMATCH'
  | 'ANALYSIS_BUNDLE_COVERAGE_INVALID'
  | 'ANALYSIS_BUNDLE_STATUS_INVALID'
  | 'ANALYSIS_BUNDLE_ASSUMPTION_INVALID'
  | 'ANALYSIS_BUNDLE_RUNTIME_DEPENDENCY_INVALID'
  | 'ANALYSIS_BUNDLE_DIGEST_MISMATCH'
  | 'ANALYSIS_BUNDLE_PLAN_MISMATCH'
  | 'ANALYSIS_BUNDLE_SOURCE_MISMATCH'
  | 'ANALYSIS_BUNDLE_PROVENANCE_INVALID';

export class AnalysisBundleValidationError extends TypeError {
  readonly code: AnalysisBundleValidationErrorCode;

  constructor(code: AnalysisBundleValidationErrorCode, message: string) {
    super(message);
    this.name = 'AnalysisBundleValidationError';
    this.code = code;
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertObservationCoverage(coverage: AnalysisObservationCoverage): void {
  if (coverage.planned !== coverage.observed
      + coverage.missing
      + coverage.notApplicable
      + coverage.invalid
      + coverage.evaluationFailed
      + coverage.sourceUnavailable
      + coverage.notStarted
      || coverage.included + coverage.excluded !== coverage.planned
      || coverage.included > coverage.observed
      || coverage.comparable > coverage.included
      || coverage.censored > coverage.sourceUnavailable) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_COVERAGE_INVALID',
      'Analysis observation coverage counters are not internally consistent.',
    );
  }
}

function runtimeDependencyKey(input: AnalysisRecord['runtimeDependencies'][number]): string {
  return `${input.runtimeKind}\u0000${input.referenceId}`;
}

function assertRecords(bundle: AnalysisBundle): void {
  const nodeIds = new Set<string>();
  const resultIds = new Set<string>();
  for (let index = 0; index < bundle.records.length; index += 1) {
    const record = bundle.records[index];
    const previous = bundle.records[index - 1];
    if (previous !== undefined && compareStrings(previous.nodeId, record.nodeId) >= 0) {
      throw new AnalysisBundleValidationError(
        previous.nodeId === record.nodeId
          ? 'ANALYSIS_BUNDLE_DUPLICATE_RECORD'
          : 'ANALYSIS_BUNDLE_RECORD_ORDER_INVALID',
        'Analysis records must use unique canonical node order.',
      );
    }
    if (nodeIds.has(record.nodeId) || resultIds.has(record.resultId)) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_DUPLICATE_RECORD',
        'Analysis records must have unique node and result identifiers.',
      );
    }
    nodeIds.add(record.nodeId);
    resultIds.add(record.resultId);
    assertObservationCoverage(record.coverage);
    if (record.exclusions.length !== record.coverage.excluded) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_COVERAGE_INVALID',
        'Analysis exclusions must account for every excluded observation row.',
      );
    }
    if (record.notApplicableRows.length !== record.coverage.notApplicable) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_COVERAGE_INVALID',
        'Analysis not-applicable rows must account for structural coverage.',
      );
    }
    const exclusionById = new Map(record.exclusions.map((entry) => [entry.rowId, entry]));
    for (let index = 0; index < record.notApplicableRows.length; index += 1) {
      const fact = record.notApplicableRows[index];
      const previousFact = record.notApplicableRows[index - 1];
      if (previousFact !== undefined && compareStrings(previousFact.rowId, fact.rowId) >= 0) {
        throw new AnalysisBundleValidationError(
          'ANALYSIS_BUNDLE_COVERAGE_INVALID',
          'Analysis not-applicable rows must use unique canonical row order.',
        );
      }
      if (exclusionById.get(fact.rowId)?.reasonCode !== fact.reasonCode) {
        throw new AnalysisBundleValidationError(
          'ANALYSIS_BUNDLE_COVERAGE_INVALID',
          'Every not-applicable row must be retained as a matching exclusion fact.',
        );
      }
    }
    for (let exclusionIndex = 0; exclusionIndex < record.exclusions.length; exclusionIndex += 1) {
      const exclusion = record.exclusions[exclusionIndex];
      const previousExclusion = record.exclusions[exclusionIndex - 1];
      if (previousExclusion !== undefined
          && compareStrings(previousExclusion.rowId, exclusion.rowId) >= 0) {
        throw new AnalysisBundleValidationError(
          'ANALYSIS_BUNDLE_COVERAGE_INVALID',
          'Analysis exclusions must use unique canonical row order.',
        );
      }
    }
    const assumptions = new Set<string>();
    for (const check of record.assumptionChecks) {
      if (check.nodeId !== record.nodeId || assumptions.has(check.assumptionId)) {
        throw new AnalysisBundleValidationError(
          'ANALYSIS_BUNDLE_ASSUMPTION_INVALID',
          'Assumption checks must be unique and bound to their Analysis node.',
        );
      }
      assumptions.add(check.assumptionId);
      if (check.checkStatus === 'passed' && check.reasonCode !== undefined) {
        throw new AnalysisBundleValidationError(
          'ANALYSIS_BUNDLE_ASSUMPTION_INVALID',
          'A passed assumption check cannot carry a failure reason.',
        );
      }
      if (check.checkStatus !== 'passed' && check.reasonCode === undefined) {
        throw new AnalysisBundleValidationError(
          'ANALYSIS_BUNDLE_ASSUMPTION_INVALID',
          'A failed or unevaluated assumption check requires a reason code.',
        );
      }
    }
    for (let dependencyIndex = 0;
      dependencyIndex < record.runtimeDependencies.length;
      dependencyIndex += 1) {
      const dependency = record.runtimeDependencies[dependencyIndex];
      const previousDependency = record.runtimeDependencies[dependencyIndex - 1];
      if (previousDependency !== undefined
          && runtimeDependencyKey(previousDependency) >= runtimeDependencyKey(dependency)) {
        throw new AnalysisBundleValidationError(
          'ANALYSIS_BUNDLE_RUNTIME_DEPENDENCY_INVALID',
          'Analysis Runtime dependencies must use unique canonical order.',
        );
      }
    }
    if (record.analysisStatus === 'completed'
        && record.assumptionChecks.some((check) => check.checkStatus !== 'passed')) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_ASSUMPTION_INVALID',
        'A completed Analysis record requires every declared assumption to pass.',
      );
    }
    const payload = { ...record };
    delete (payload as Partial<AnalysisRecord>).recordDigest;
    const expected = digestCanonicalJson(payload);
    if (expected !== record.recordDigest) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_RECORD_DIGEST_MISMATCH',
        'Analysis record digest does not match its canonical payload.',
      );
    }
  }
}

function assertCoverage(bundle: AnalysisBundle): void {
  const actual = {
    completed: 0,
    inconclusive: 0,
    failed: 0,
    notStarted: 0,
  };
  for (const record of bundle.records) {
    if (record.analysisStatus === 'completed') actual.completed += 1;
    else if (record.analysisStatus === 'inconclusive') actual.inconclusive += 1;
    else if (record.analysisStatus === 'failed') actual.failed += 1;
    else actual.notStarted += 1;
  }
  const coverage = bundle.coverage;
  if (coverage.planned !== bundle.records.length
      || coverage.started !== coverage.completed + coverage.inconclusive + coverage.failed
      || coverage.planned !== coverage.started + coverage.notStarted
      || canonicalizeJson(actual) !== canonicalizeJson({
        completed: coverage.completed,
        inconclusive: coverage.inconclusive,
        failed: coverage.failed,
        notStarted: coverage.notStarted,
      })) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_COVERAGE_INVALID',
      'AnalysisBundle coverage counters do not match its records.',
    );
  }
}

function assertStatus(bundle: AnalysisBundle): void {
  if (bundle.analysisBundleStatus === 'completed') {
    if (bundle.terminationReasonCode !== undefined
        || bundle.coverage.failed !== 0) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_STATUS_INVALID',
        'A completed AnalysisBundle cannot contain failed nodes.',
      );
    }
    return;
  }
  if (bundle.terminationReasonCode === undefined) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_STATUS_INVALID',
      'A non-completed AnalysisBundle requires a termination reason code.',
    );
  }
}

export function parseAnalysisBundleDocument(value: unknown): AnalysisBundle {
  const bundle = parseWireDocument(AnalysisBundleSchema, value);
  assertRecords(bundle);
  assertCoverage(bundle);
  assertStatus(bundle);
  if (digestArtifactPayload(bundle, 'bundleDigest') !== bundle.bundleDigest) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_DIGEST_MISMATCH',
      'AnalysisBundle digest does not match its canonical payload.',
    );
  }
  return bundle;
}

export interface AnalysisBundlePlanContext extends EvaluationBundlePlanContext {
  analysis: {
    analysisPlanDigest: string;
    evaluationPlanDigest: string;
    analysisGraph: {
      analysisMode: 'preregistered' | 'exploratory';
      nodes: readonly {
        nodeId: string;
        analysisNodeKind: 'reducer' | 'estimator' | 'correction';
        outputResultId: string;
        parameters?: unknown;
        targetFilter?: { includeTargetIds: readonly string[] };
        cohortFilter?: {
          includeCohortIds?: readonly string[];
          excludeCohortIds?: readonly string[];
        };
        inputs: readonly ({
          inputKind: 'metric-observations' | 'analysis-result';
          referenceId: string;
        } | {
          inputKind: 'comparison';
          referenceId: string;
          treatmentTargetId: string;
          metricId: string;
        })[];
      }[];
    };
    samples: readonly {
      sampleId: string;
      analysis?: { memberships: readonly { cohortId: string }[] };
    }[];
    experiment: {
      sampling: {
        resamplingUnit: 'sample' | 'paired-block' | 'cluster' | 'run';
      };
    };
    metrics: readonly { metricId: string; missingPolicyId: string }[];
    comparisons: readonly {
      comparisonId: string;
      controlTargetId: string;
      treatmentTargetIds: readonly string[];
      metricIds: readonly string[];
    }[];
    runtimes: readonly {
      runtimeKind: 'executor' | 'evaluator' | 'analysis-node' | 'missing-policy' | 'decision-policy';
      referenceId: string;
      identity: unknown;
    }[];
  };
}

export interface AnalysisBundleValidationContext {
  readonly schemaValidators: ReadonlyMap<string, CoreSchemaValidator>;
}

export interface AnalysisBundleVerificationContext {
  /** Independently attested by the producing Runtime or a host trust verifier. */
  readonly verifiedProvenanceBundleDigests?: ReadonlySet<Sha256Digest>;
  /** Effective trust independently observed from the Evaluation source at production time. */
  readonly evaluationSourceTrust?: Provenance['trust'];
}

export interface AnalysisBundlePlanVerification {
  readonly provenanceTrustStatus: 'verified' | 'indeterminate';
  readonly evaluationSourceTrust: Provenance['trust'];
}

declare const analysisBundleSourceBrand: unique symbol;

export interface AnalysisBundleVerificationResult {
  readonly [analysisBundleSourceBrand]: true;
  readonly bundle: AnalysisBundle;
  readonly planVerification: AnalysisBundlePlanVerification;
}

export type AnalysisBundleSource = AnalysisBundleVerificationResult;

const analysisBundleSources = new WeakSet<object>();

export function assertAnalysisBundleSource(
  value: unknown,
): asserts value is AnalysisBundleSource {
  if (value === null || typeof value !== 'object' || !analysisBundleSources.has(value)) {
    throw new TypeError(
      'Decision stage requires a source returned by parseAnalysisBundle() or the Runtime.',
    );
  }
}

export function assertAnalysisBundleSourceChain(
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  analysisSource: AnalysisBundleSource,
): void {
  assertEvaluationBundleSourceChain(executionSource, evaluationSource);
  assertAnalysisBundleSource(analysisSource);
  if (analysisSource.bundle.evaluationBundleDigest
      !== evaluationSource.bundle.bundleDigest) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_SOURCE_MISMATCH',
      'Analysis source is not bound to the supplied Evaluation source.',
    );
  }
}

export function assertAnalysisBundleSourceMatchesPlan(
  plan: AnalysisBundlePlanContext,
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  analysisSource: AnalysisBundleSource,
): void {
  assertEvaluationBundleSourceMatchesPlan(plan, executionSource, evaluationSource);
  assertAnalysisBundleSourceChain(executionSource, evaluationSource, analysisSource);
  if (analysisSource.bundle.analysisPlanDigest !== plan.analysis.analysisPlanDigest) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_PLAN_MISMATCH',
      'Analysis source does not match the current AnalysisPlan.',
    );
  }
}

export function effectiveAnalysisBundleTrust(
  source: AnalysisBundleSource,
): AnalysisBundle['provenance']['trust'] {
  assertAnalysisBundleSource(source);
  const trusts: Provenance['trust'][] = [
    source.bundle.provenance.trust,
    source.planVerification.evaluationSourceTrust,
    source.planVerification.provenanceTrustStatus === 'verified' ? 'verified' : 'unknown',
  ];
  return trusts.sort((left, right) => TRUST_LEVEL[left] - TRUST_LEVEL[right])[0];
}

interface ExpectedAnalysisRow {
  rowId: string;
  metricId: string;
  targetId: string;
  sampleId: string;
  samplingUnitIds: {
    pairingBlockId?: string;
    clusterId?: string;
  };
  rowStatus: 'observed' | 'missing' | 'invalid' | 'evaluation-failed'
    | 'source-unavailable' | 'not-started';
  censored: boolean;
  reasonCode?: string;
}

function coordinateKey(value: {
  targetId: string;
  sampleId: string;
  trialIndex: number;
}): string {
  return canonicalizeJson([value.targetId, value.sampleId, value.trialIndex]);
}

function evaluationKey(value: {
  targetId: string;
  sampleId: string;
  trialIndex: number;
  evaluatorId: string;
}): string {
  return canonicalizeJson([
    value.targetId,
    value.sampleId,
    value.trialIndex,
    value.evaluatorId,
  ]);
}

function expectedRows(
  plan: AnalysisBundlePlanContext,
  execution: ExecutionBundle,
  evaluation: EvaluationBundle,
  node: AnalysisBundlePlanContext['analysis']['analysisGraph']['nodes'][number],
): ExpectedAnalysisRow[] {
  const metricIds = new Set(node.inputs
    .filter((input) => input.inputKind === 'metric-observations')
    .map((input) => input.referenceId));
  if (metricIds.size === 0) return [];
  const includeTargetIds = new Set(node.targetFilter?.includeTargetIds ?? []);
  const includeCohortIds = new Set(node.cohortFilter?.includeCohortIds ?? []);
  const excludeCohortIds = new Set(node.cohortFilter?.excludeCohortIds ?? []);
  const cohortIdsBySample = new Map(plan.analysis.samples.map((sample) => [
    sample.sampleId,
    new Set(sample.analysis?.memberships.map((membership) => membership.cohortId) ?? []),
  ]));
  const comparisonInputs = node.inputs.filter((input) => input.inputKind === 'comparison');
  const comparisonById = new Map(plan.analysis.comparisons.map(
    (comparison) => [comparison.comparisonId, comparison],
  ));
  const evaluatorById = new Map(plan.evaluation.evaluators.map(
    (evaluator) => [evaluator.evaluatorId, evaluator],
  ));
  const executionByCoordinate = new Map(execution.records.map(
    (record) => [coordinateKey(record), record],
  ));
  const plannedExecutionByCoordinate = new Map(derivePlannedExecutionCoordinates(plan).map(
    (coordinate) => [coordinateKey(coordinate), coordinate],
  ));
  const evaluationByCoordinate = new Map(evaluation.records.map(
    (record) => [evaluationKey(record), record],
  ));
  const rows: ExpectedAnalysisRow[] = [];
  for (const coordinate of derivePlannedEvaluationCoordinates(plan)) {
    if (includeTargetIds.size > 0 && !includeTargetIds.has(coordinate.targetId)) continue;
    const sampleCohortIds = cohortIdsBySample.get(coordinate.sampleId) ?? new Set<string>();
    if (includeCohortIds.size > 0
        && ![...includeCohortIds].some((cohortId) => sampleCohortIds.has(cohortId))) continue;
    if ([...excludeCohortIds].some((cohortId) => sampleCohortIds.has(cohortId))) continue;
    const evaluator = evaluatorById.get(coordinate.evaluatorId);
    if (evaluator === undefined) continue;
    for (const metricId of evaluator.metricIds) {
      if (!metricIds.has(metricId)) continue;
      const matchingContrasts = comparisonInputs.filter((input) => (
        analysisComparisonAppliesToMetricInput(node, input.metricId, metricId)
      ));
      if (comparisonInputs.length > 0 && matchingContrasts.length === 0) continue;
      const allowedTargets = matchingContrasts.length === 0 ? undefined : new Set(
        matchingContrasts.flatMap((input) => {
          const comparison = comparisonById.get(input.referenceId);
          return comparison === undefined
            ? []
            : [comparison.controlTargetId, input.treatmentTargetId];
        }),
      );
      if (allowedTargets !== undefined && !allowedTargets.has(coordinate.targetId)) continue;
      const executionRecord = executionByCoordinate.get(coordinateKey(coordinate));
      const plannedExecution = plannedExecutionByCoordinate.get(coordinateKey(coordinate));
      if (plannedExecution === undefined) {
        throw new AnalysisBundleValidationError(
          'ANALYSIS_BUNDLE_PLAN_MISMATCH',
          'Analysis source row has no sealed execution coordinate.',
        );
      }
      const evaluationRecord = evaluationByCoordinate.get(evaluationKey(coordinate));
      const base = {
        rowId: digestCanonicalJson({
          derivation: 'omk.analysis-metric-row-id/v1',
          evaluationId: coordinate.evaluationId,
          metricId,
        }),
        metricId,
        targetId: coordinate.targetId,
        sampleId: coordinate.sampleId,
        samplingUnitIds: plannedExecution.samplingUnitIds,
        censored: executionRecord?.executionStatus === 'budget-censored',
      };
      if (evaluationRecord === undefined) {
        rows.push({
          ...base,
          rowStatus: 'not-started',
          reasonCode: 'evaluation-not-started',
        });
      } else if (evaluationRecord.evaluationStatus === 'not-evaluated') {
        rows.push({
          ...base,
          rowStatus: 'source-unavailable',
          reasonCode: evaluationRecord.notEvaluatedReasonCode,
        });
      } else if (evaluationRecord.evaluationStatus === 'failed'
          || evaluationRecord.evaluationStatus === 'cancelled') {
        rows.push({
          ...base,
          rowStatus: 'evaluation-failed',
          reasonCode: evaluationRecord.evaluationStatus === 'failed'
            ? evaluationRecord.error.code
            : evaluationRecord.error?.code ?? 'evaluation-cancelled',
        });
      } else {
        const observation = evaluationRecord.observations.find(
          (candidate) => candidate.metricId === metricId,
        );
        if (observation === undefined) continue;
        rows.push(observation.observationStatus === 'observed'
          ? { ...base, rowStatus: 'observed' }
          : {
            ...base,
            rowStatus: observation.observationStatus,
            reasonCode: observation.reasonCode,
          });
      }
    }
  }
  return rows.sort((left, right) => compareStrings(left.rowId, right.rowId));
}

function assertSourceCoverage(
  record: AnalysisRecord,
  rows: readonly ExpectedAnalysisRow[],
): void {
  const notApplicableIds = new Set(record.notApplicableRows.map((entry) => entry.rowId));
  const expected = {
    planned: rows.length,
    observed: rows.filter((row) => row.rowStatus === 'observed').length,
    missing: rows.filter((row) => (
      row.rowStatus === 'missing' && !notApplicableIds.has(row.rowId)
    )).length,
    notApplicable: record.notApplicableRows.length,
    invalid: rows.filter((row) => row.rowStatus === 'invalid').length,
    evaluationFailed: rows.filter((row) => row.rowStatus === 'evaluation-failed').length,
    sourceUnavailable: rows.filter((row) => row.rowStatus === 'source-unavailable').length,
    notStarted: rows.filter((row) => row.rowStatus === 'not-started').length,
    censored: rows.filter((row) => row.censored).length,
  };
  const actual = {
    planned: record.coverage.planned,
    observed: record.coverage.observed,
    missing: record.coverage.missing,
    notApplicable: record.coverage.notApplicable,
    invalid: record.coverage.invalid,
    evaluationFailed: record.coverage.evaluationFailed,
    sourceUnavailable: record.coverage.sourceUnavailable,
    notStarted: record.coverage.notStarted,
    censored: record.coverage.censored,
  };
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_SOURCE_MISMATCH',
      'Analysis record coverage does not match the source observation universe.',
    );
  }
  const byId = new Map(rows.map((row) => [row.rowId, row]));
  const exclusionById = new Map(record.exclusions.map((entry) => [entry.rowId, entry]));
  if (record.exclusions.some((entry) => !byId.has(entry.rowId))
      || record.notApplicableRows.some((entry) => {
        const row = byId.get(entry.rowId);
        return row?.rowStatus !== 'missing'
          || row.censored
          || row.reasonCode !== entry.reasonCode;
      })
      || rows.some((row) => row.rowStatus !== 'observed'
        && (exclusionById.get(row.rowId)?.reasonCode !== row.reasonCode))) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_SOURCE_MISMATCH',
      'Analysis exclusions do not match source observation identities and reasons.',
    );
  }
}

const TRUST_LEVEL = {
  untrusted: 0,
  unknown: 1,
  declared: 2,
  verified: 3,
} as const;

export function analysisRuntimeDependencyTrusts(
  plan: Pick<AnalysisBundlePlanContext, 'analysis'>,
  records: readonly AnalysisRecord[],
): Provenance['trust'][] {
  const runtimeByKey = new Map(plan.analysis.runtimes.map((runtime) => [
    `${runtime.runtimeKind}\u0000${runtime.referenceId}`,
    runtime,
  ]));
  const dependencies = new Set(records.flatMap((record) => (
    record.runtimeDependencies.map(runtimeDependencyKey)
  )));
  return [...dependencies].sort(compareStrings).map((key) => {
    const identity = runtimeByKey.get(key)?.identity;
    const assurance = identity !== null && typeof identity === 'object'
      ? (identity as Record<string, unknown>).assuranceLevel
      : undefined;
    return typeof assurance === 'string' && assurance in TRUST_LEVEL
      ? assurance as Provenance['trust']
      : 'untrusted';
  });
}

function expectedMissingPolicyIds(
  plan: AnalysisBundlePlanContext,
  node: AnalysisBundlePlanContext['analysis']['analysisGraph']['nodes'][number],
  sourceRows: readonly ExpectedAnalysisRow[],
): Set<string> {
  const nonObservedMetricIds = new Set(sourceRows
    .filter((row) => row.rowStatus !== 'observed')
    .map((row) => row.metricId));
  const metricById = new Map(plan.analysis.metrics.map((metric) => [metric.metricId, metric]));
  return new Set(node.inputs.flatMap((input) => {
    if (input.inputKind !== 'metric-observations'
        || !nonObservedMetricIds.has(input.referenceId)) return [];
    const policyId = metricById.get(input.referenceId)?.missingPolicyId;
    return policyId === undefined ? [] : [policyId];
  }));
}

function assertRuntimeDependencies(
  record: AnalysisRecord,
  plan: AnalysisBundlePlanContext,
  node: AnalysisBundlePlanContext['analysis']['analysisGraph']['nodes'][number],
  sourceRows: readonly ExpectedAnalysisRow[],
): void {
  const availableRuntimeKeys = new Set(plan.analysis.runtimes.map((runtime) => (
    `${runtime.runtimeKind}\u0000${runtime.referenceId}`
  )));
  const expectedPolicyIds = expectedMissingPolicyIds(plan, node, sourceRows);
  const dependencyKeys = new Set(record.runtimeDependencies.map(runtimeDependencyKey));
  const nodeDependencyKey = `analysis-node\u0000${node.nodeId}`;
  for (const dependency of record.runtimeDependencies) {
    if (!availableRuntimeKeys.has(runtimeDependencyKey(dependency))
        || (dependency.runtimeKind === 'analysis-node' && dependency.referenceId !== node.nodeId)
        || (dependency.runtimeKind === 'missing-policy'
          && !expectedPolicyIds.has(dependency.referenceId))) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_RUNTIME_DEPENDENCY_INVALID',
        'Analysis Runtime dependency does not match a reachable sealed Runtime.',
      );
    }
  }
  if (record.analysisStatus === 'completed' && !dependencyKeys.has(nodeDependencyKey)) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_RUNTIME_DEPENDENCY_INVALID',
      'A completed Analysis record must depend on its AnalysisNode Runtime.',
    );
  }
  if (dependencyKeys.has(nodeDependencyKey)
      && [...expectedPolicyIds].some((policyId) => (
        !dependencyKeys.has(`missing-policy\u0000${policyId}`)
      ))) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_RUNTIME_DEPENDENCY_INVALID',
      'An invoked AnalysisNode must retain every preceding MissingPolicy dependency.',
    );
  }
  if (!dependencyKeys.has(nodeDependencyKey)
      && record.analysisStatus === 'inconclusive'
      && (expectedPolicyIds.size === 0 || [...expectedPolicyIds].some((policyId) => (
        !dependencyKeys.has(`missing-policy\u0000${policyId}`)
      )))) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_RUNTIME_DEPENDENCY_INVALID',
      'An inconclusive pre-node result must retain every consulted MissingPolicy dependency.',
    );
  }
  if (!dependencyKeys.has(nodeDependencyKey) && record.analysisStatus === 'inconclusive') {
    const rejectionCodes = record.assumptionChecks.flatMap((check) => (
      check.assumptionId.startsWith('missing-policy-')
          && check.checkStatus === 'failed'
          && check.reasonCode?.startsWith('missing-policy-rejected:') === true
        ? [check.reasonCode]
        : []
    )).sort(compareStrings);
    if (canonicalizeJson(record.reasonCodes) !== canonicalizeJson(rejectionCodes)) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_RUNTIME_DEPENDENCY_INVALID',
        'An inconclusive pre-node result must be explained by MissingPolicy rejections.',
      );
    }
  }
  if (!dependencyKeys.has(nodeDependencyKey)
      && record.analysisStatus === 'failed'
      && !record.runtimeDependencies.some((dependency) => (
        dependency.runtimeKind === 'missing-policy'
      ))) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_RUNTIME_DEPENDENCY_INVALID',
      'A failed pre-node result must retain its failing MissingPolicy dependency.',
    );
  }
}

function assertMatchesPlan(
  bundle: AnalysisBundle,
  plan: AnalysisBundlePlanContext,
  execution: ExecutionBundle,
  source: EvaluationBundle,
  sourceTrust: Provenance['trust'],
  validation: AnalysisBundleValidationContext,
): void {
  if (bundle.analysisPlanDigest !== plan.analysis.analysisPlanDigest) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_PLAN_MISMATCH',
      'AnalysisBundle does not match the current AnalysisPlan.',
    );
  }
  if (bundle.evaluationBundleDigest !== source.bundleDigest) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_SOURCE_MISMATCH',
      'AnalysisBundle parent identities do not match the source EvaluationBundle.',
    );
  }
  const nodeById = new Map(plan.analysis.analysisGraph.nodes.map((node) => [node.nodeId, node]));
  const recordByResultId = new Map(bundle.records.map((record) => [record.resultId, record]));
  const runtimeByNodeId = new Map(plan.analysis.runtimes
    .filter((runtime) => runtime.runtimeKind === 'analysis-node')
    .map((runtime) => [runtime.referenceId, runtime]));
  if (bundle.records.length !== nodeById.size) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_PLAN_MISMATCH',
      'AnalysisBundle does not cover the complete sealed AnalysisGraph.',
    );
  }
  for (const record of bundle.records) {
    const node = nodeById.get(record.nodeId);
    const runtime = runtimeByNodeId.get(record.nodeId);
    const runtimeIdentity = runtime?.identity;
    const capabilities = runtimeIdentity !== null && typeof runtimeIdentity === 'object'
      ? (runtimeIdentity as Record<string, unknown>).capabilities
      : undefined;
    const outputSchema = SchemaIdentitySchema.safeParse(
      capabilities !== null && typeof capabilities === 'object'
        ? (capabilities as Record<string, unknown>).outputSchema
        : undefined,
    );
    if (node === undefined
        || runtime === undefined
        || record.resultId !== node.outputResultId
        || record.analysisNodeKind !== node.analysisNodeKind
        || record.analysisMode !== plan.analysis.analysisGraph.analysisMode
        || canonicalizeJson(record.inputReferences) !== canonicalizeJson(node.inputs)
        || canonicalizeJson(record.implementation) !== canonicalizeJson(runtimeIdentity)
        || !outputSchema.success
        || canonicalizeJson(record.outputSchema) !== canonicalizeJson(outputSchema.data)) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_PLAN_MISMATCH',
        'Analysis record does not match its sealed node and Runtime binding.',
      );
    }
    const validator = validation.schemaValidators.get(schemaIdentityKey(record.outputSchema));
    if (validator === undefined
        || canonicalizeJson(validator.schema) !== canonicalizeJson(record.outputSchema)) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_PLAN_MISMATCH',
        'Analysis output schema has no independently bound Core validator.',
      );
    }
    const sourceRows = expectedRows(plan, execution, source, node);
    assertRuntimeDependencies(record, plan, node, sourceRows);
    if (record.analysisStatus === 'completed') {
      let valid = false;
      try {
        const envelope = { resultType: record.resultType, value: record.value } as const;
        const excludedRowIds = new Set(record.exclusions.map((entry) => entry.rowId));
        valid = canonicalizeJson(validator.parse(envelope, {
          validationKind: 'analysis-output',
          parameters: node.parameters ?? {},
          inputFacts: {
            resamplingUnitCount: countAnalysisResamplingUnits(
              plan.analysis.experiment.sampling.resamplingUnit,
              sourceRows.filter((row) => (
                row.rowStatus === 'observed' && !excludedRowIds.has(row.rowId)
              )),
              node.inputs.flatMap((input) => {
                if (input.inputKind !== 'comparison') return [];
                const comparison = plan.analysis.comparisons.find(
                  (candidate) => candidate.comparisonId === input.referenceId,
                );
                return comparison === undefined
                  ? []
                  : [comparison.controlTargetId, input.treatmentTargetId];
              }),
            ),
            analysisResultInputs: node.inputs.flatMap((input) => {
              if (input.inputKind !== 'analysis-result') return [];
              const sourceRecord = recordByResultId.get(input.referenceId);
              return sourceRecord?.analysisStatus === 'completed'
                ? [{
                  referenceId: input.referenceId,
                  resultType: sourceRecord.resultType,
                  value: sourceRecord.value,
                }]
                : [];
            }),
          },
        })) === canonicalizeJson(envelope);
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new AnalysisBundleValidationError(
          'ANALYSIS_BUNDLE_PLAN_MISMATCH',
          'Analysis result envelope does not match its sealed output schema.',
        );
      }
    }
    assertSourceCoverage(record, sourceRows);
    const parents = new Set<string>();
    for (const input of node.inputs) {
      if (input.inputKind === 'metric-observations') parents.add(source.bundleDigest);
      else if (input.inputKind === 'comparison') parents.add(bundle.analysisPlanDigest);
      else {
        const parent = recordByResultId.get(input.referenceId);
        if (parent === undefined) {
          throw new AnalysisBundleValidationError(
            'ANALYSIS_BUNDLE_PLAN_MISMATCH',
            'Analysis record references a missing parent result.',
          );
        }
        parents.add(parent.recordDigest);
      }
    }
    const expectedParents = [...parents].sort(compareStrings);
    if (canonicalizeJson(record.parentDigests) !== canonicalizeJson(expectedParents)) {
      throw new AnalysisBundleValidationError(
        'ANALYSIS_BUNDLE_PLAN_MISMATCH',
        'Analysis record parent digests do not match its declared inputs.',
      );
    }
  }
  const runtimeTrusts = analysisRuntimeDependencyTrusts(plan, bundle.records);
  const trustCeiling = [sourceTrust, ...runtimeTrusts].sort(
    (left, right) => TRUST_LEVEL[left] - TRUST_LEVEL[right],
  )[0];
  if (canonicalizeJson(bundle.provenance.parentDigests)
        !== canonicalizeJson([source.bundleDigest])
      || TRUST_LEVEL[bundle.provenance.trust] > TRUST_LEVEL[trustCeiling]) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_PROVENANCE_INVALID',
      'Analysis provenance must bind exactly one source EvaluationBundle and cannot upgrade trust.',
    );
  }
}

export function parseAnalysisBundle(
  value: unknown,
  plan: AnalysisBundlePlanContext,
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  validation: AnalysisBundleValidationContext,
): AnalysisBundleSource {
  return verifyAnalysisBundle(
    value,
    plan,
    executionSource,
    evaluationSource,
    validation,
  );
}

export function verifyAnalysisBundle(
  value: unknown,
  plan: AnalysisBundlePlanContext,
  executionSource: ExecutionBundleSource,
  evaluationSource: EvaluationBundleSource,
  validation: AnalysisBundleValidationContext,
  verification?: AnalysisBundleVerificationContext,
): AnalysisBundleSource {
  assertEvaluationBundleSourceMatchesPlan(plan, executionSource, evaluationSource);
  const execution = executionSource.bundle;
  const source = evaluationSource.bundle;
  const bundle = parseAnalysisBundleDocument(value);
  const sourceTrust = verification?.evaluationSourceTrust ?? source.provenance.trust;
  const effectiveSourceTrust = verification?.evaluationSourceTrust
    ?? effectiveEvaluationBundleTrust(evaluationSource);
  assertMatchesPlan(bundle, plan, execution, source, sourceTrust, validation);
  const result = {
    bundle,
    planVerification: {
      provenanceTrustStatus: verification?.verifiedProvenanceBundleDigests?.has(
        bundle.bundleDigest as Sha256Digest,
      ) === true
        ? 'verified' as const
        : 'indeterminate' as const,
      evaluationSourceTrust: effectiveSourceTrust,
    },
  } as AnalysisBundleVerificationResult;
  analysisBundleSources.add(result);
  return deepFreezeCanonicalJson(result);
}
