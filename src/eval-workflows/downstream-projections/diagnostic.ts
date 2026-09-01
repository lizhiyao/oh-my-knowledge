import {
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type JsonValue,
} from '../../evaluation-core/contracts/index.js';
import type { StoredCoreRunArtifacts } from '../artifact-store/index.js';
import {
  CORE_DIAGNOSTIC_PROJECTION_SCHEMA_VERSION,
  type CoreDiagnosticFinding,
  type CoreDiagnosticProjection,
} from './contracts.js';
import { assertCoreProjectionSource } from './source.js';

type FindingInput = Omit<CoreDiagnosticFinding, 'findingId'>;

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finding(input: FindingInput): CoreDiagnosticFinding {
  return {
    findingId: digestCanonicalJson({
      derivation: CORE_DIAGNOSTIC_PROJECTION_SCHEMA_VERSION,
      ...input,
    }),
    ...input,
  };
}

function bundleTerminationFindings(
  source: Readonly<StoredCoreRunArtifacts>,
): CoreDiagnosticFinding[] {
  const entries = [
    ['execution', source.execution.bundleDigest, source.execution.terminationReasonCode,
      source.execution.executionBundleStatus],
    ['evaluation', source.evaluation.bundleDigest, source.evaluation.terminationReasonCode,
      source.evaluation.evaluationBundleStatus],
    ['analysis', source.analysis.bundleDigest, source.analysis.terminationReasonCode,
      source.analysis.analysisBundleStatus],
  ] as const;
  return entries.flatMap(([stage, sourceDigest, reasonCode, status]) => reasonCode === undefined ? [] : [
    finding({
      stage,
      severity: status === 'failed' ? 'error' : 'warning',
      reasonCode,
      sourceDigest,
    }),
  ]);
}

/**
 * Projects only explicit Core failures, exclusions, missing observations, and stable reasons.
 * It never reads captured output／trace content and never invents scores or recommendations.
 */
export function projectCoreDiagnostics(
  source: Readonly<StoredCoreRunArtifacts>,
): CoreDiagnosticProjection {
  assertCoreProjectionSource(source);
  const findings: CoreDiagnosticFinding[] = bundleTerminationFindings(source);

  for (const record of source.execution.records) {
    const scope = {
      targetId: record.targetId,
      sampleId: record.sampleId,
      trialIndex: record.trialIndex,
    };
    if (record.executionStatus === 'failed') findings.push(finding({
      stage: 'execution', severity: 'error', reasonCode: record.error.code,
      sourceDigest: record.trialId, scope,
    }));
    else if (record.executionStatus === 'cancelled') findings.push(finding({
      stage: 'execution', severity: 'warning',
      reasonCode: record.error?.code ?? 'execution-record-cancelled',
      sourceDigest: record.trialId, scope,
    }));
    else if (record.executionStatus === 'budget-censored') findings.push(finding({
      stage: 'execution', severity: 'warning', reasonCode: record.censorReasonCode,
      sourceDigest: record.trialId, scope,
    }));
  }

  for (const record of source.evaluation.records) {
    const scope = {
      targetId: record.targetId,
      sampleId: record.sampleId,
      trialIndex: record.trialIndex,
      evaluatorId: record.evaluatorId,
    };
    if (record.evaluationStatus === 'failed') findings.push(finding({
      stage: 'evaluation', severity: 'error', reasonCode: record.error.code,
      sourceDigest: record.evaluationId, scope,
    }));
    else if (record.evaluationStatus === 'cancelled') findings.push(finding({
      stage: 'evaluation', severity: 'warning',
      reasonCode: record.error?.code ?? 'evaluation-record-cancelled',
      sourceDigest: record.evaluationId, scope,
    }));
    else if (record.evaluationStatus === 'not-evaluated') findings.push(finding({
      stage: 'evaluation', severity: 'warning', reasonCode: record.notEvaluatedReasonCode,
      sourceDigest: record.evaluationId, scope,
    }));
    else {
      for (const observation of record.observations) {
        if (observation.observationStatus === 'observed') continue;
        findings.push(finding({
          stage: 'evaluation', severity: 'warning', reasonCode: observation.reasonCode,
          sourceDigest: observation.observationId,
          scope: { ...scope, metricId: observation.metricId },
        }));
      }
    }
  }

  for (const record of source.analysis.records) {
    const scope = { nodeId: record.nodeId };
    if (record.analysisStatus === 'failed') findings.push(finding({
      stage: 'analysis', severity: 'error', reasonCode: record.error.code,
      sourceDigest: record.recordDigest, scope,
    }));
    else if (record.analysisStatus === 'inconclusive'
        || record.analysisStatus === 'not-evaluated') {
      for (const reasonCode of record.reasonCodes) findings.push(finding({
        stage: 'analysis',
        severity: record.analysisStatus === 'inconclusive' ? 'warning' : 'info',
        reasonCode,
        sourceDigest: record.recordDigest,
        scope,
      }));
    }
    for (const check of record.assumptionChecks) {
      if (check.checkStatus === 'passed' || check.reasonCode === undefined) continue;
      findings.push(finding({
        stage: 'analysis',
        severity: check.checkStatus === 'failed' ? 'warning' : 'info',
        reasonCode: check.reasonCode,
        sourceDigest: record.recordDigest,
        scope,
      }));
    }
    for (const exclusion of record.exclusions) findings.push(finding({
      stage: 'analysis', severity: 'info', reasonCode: exclusion.reasonCode,
      sourceDigest: exclusion.rowId, scope,
    }));
  }

  const decision = source.report.decision;
  if (decision?.decisionStatus === 'not-decided') {
    for (const reasonCode of decision.reasonCodes) findings.push(finding({
      stage: 'decision', severity: 'warning', reasonCode,
      sourceDigest: decision.decisionDigest,
    }));
  } else if (decision?.decisionStatus === 'failed') findings.push(finding({
    stage: 'decision', severity: 'error', reasonCode: decision.error.code,
    sourceDigest: decision.decisionDigest,
  }));

  const stageOrder = { execution: 0, evaluation: 1, analysis: 2, decision: 3 } as const;
  findings.sort((left, right) => (
    stageOrder[left.stage] - stageOrder[right.stage]
    || compareCanonicalStrings(
      canonicalizeJson(left.scope ?? null),
      canonicalizeJson(right.scope ?? null),
    )
    || compareCanonicalStrings(left.reasonCode, right.reasonCode)
    || compareCanonicalStrings(left.sourceDigest, right.sourceDigest)
  ));
  return deepFreezeCanonicalJson({
    projectionKind: 'core-diagnostic',
    schemaVersion: CORE_DIAGNOSTIC_PROJECTION_SCHEMA_VERSION,
    runId: source.manifest.runId,
    reportDigest: source.report.reportDigest,
    status: source.report.status,
    findings,
  } as unknown as JsonValue) as unknown as CoreDiagnosticProjection;
}
