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
} from './common.js';
import { derivePlannedEvaluationCoordinates } from './evaluation-identities.js';
import {
  countAnalysisResamplingUnits,
} from './analysis-identities.js';
import { derivePlannedExecutionCoordinates } from './execution-identities.js';
import {
  assertEvaluationBundleSource,
  type EvaluationBundlePlanContext,
  type EvaluationBundleSource,
} from './evaluation-bundle.js';
import { digestArtifactPayload } from './digests.js';
import {
  assertExecutionBundleSource,
  type ExecutionBundleSource,
} from './execution-bundle.js';
import {
  canonicalizeJson,
  digestCanonicalJson,
  parseWireDocument,
} from './json.js';

export type AnalysisBundleValidationErrorCode =
  | 'ANALYSIS_BUNDLE_DUPLICATE_RECORD'
  | 'ANALYSIS_BUNDLE_RECORD_ORDER_INVALID'
  | 'ANALYSIS_BUNDLE_RECORD_DIGEST_MISMATCH'
  | 'ANALYSIS_BUNDLE_COVERAGE_INVALID'
  | 'ANALYSIS_BUNDLE_STATUS_INVALID'
  | 'ANALYSIS_BUNDLE_ASSUMPTION_INVALID'
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

interface ExpectedAnalysisRow {
  rowId: string;
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
    const evaluator = evaluatorById.get(coordinate.evaluatorId);
    if (evaluator === undefined) continue;
    for (const metricId of evaluator.metricIds) {
      if (!metricIds.has(metricId)) continue;
      const matchingContrasts = comparisonInputs.filter((input) => input.metricId === metricId);
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
  const expected = {
    planned: rows.length,
    observed: rows.filter((row) => row.rowStatus === 'observed').length,
    missing: rows.filter((row) => row.rowStatus === 'missing').length,
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

function assertMatchesPlan(
  bundle: AnalysisBundle,
  plan: AnalysisBundlePlanContext,
  execution: ExecutionBundle,
  source: EvaluationBundle,
  validation: AnalysisBundleValidationContext,
): void {
  if (bundle.runContractDigest !== plan.digests.runContractDigest
      || bundle.analysisPlanDigest !== plan.analysis.analysisPlanDigest
      || bundle.evaluationBundleDigest !== source.bundleDigest) {
    throw new AnalysisBundleValidationError(
      'ANALYSIS_BUNDLE_SOURCE_MISMATCH',
      'AnalysisBundle parent identities do not match the sealed plan and source bundle.',
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
  const executedNodeIds = new Set(plan.analysis.analysisGraph.nodes.map((node) => node.nodeId));
  const usedMissingPolicyIds = new Set(plan.analysis.metrics.map(
    (metric) => metric.missingPolicyId,
  ));
  const runtimeTrusts = plan.analysis.runtimes.flatMap((runtime) => {
    if (!((runtime.runtimeKind === 'analysis-node' && executedNodeIds.has(runtime.referenceId))
      || (runtime.runtimeKind === 'missing-policy' && usedMissingPolicyIds.has(runtime.referenceId)))) {
      return [];
    }
    const identity = runtime.identity;
    const assurance = identity !== null && typeof identity === 'object'
      ? (identity as Record<string, unknown>).assuranceLevel
      : undefined;
    return typeof assurance === 'string' && assurance in TRUST_LEVEL
      ? [assurance as keyof typeof TRUST_LEVEL]
      : ['untrusted' as const];
  });
  const trustCeiling = [source.provenance.trust, ...runtimeTrusts].sort(
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
): AnalysisBundle {
  assertExecutionBundleSource(executionSource);
  assertEvaluationBundleSource(evaluationSource);
  const execution = executionSource.bundle;
  const source = evaluationSource.bundle;
  const bundle = parseAnalysisBundleDocument(value);
  assertMatchesPlan(bundle, plan, execution, source, validation);
  return bundle;
}
