import {
  canonicalizeJson,
  digestCanonicalJson,
} from '../../eval-core/contracts/index.js';
import type { StoredCoreRunArtifacts } from '../artifact-store/index.js';
import { CoreDownstreamProjectionError } from './contracts.js';

function fail(): never {
  throw new CoreDownstreamProjectionError(
    'CORE_PROJECTION_SOURCE_INVALID',
    'Core downstream projection requires one exact persisted Plan, Bundle, Report, and manifest chain.',
  );
}

export function assertCoreProjectionSource(
  source: Readonly<StoredCoreRunArtifacts>,
): void {
  const { manifest, plan, execution, evaluation, analysis, report } = source;
  const { manifestDigest, ...manifestPayload } = manifest;
  const references = [
    ['run-plan', plan.digests.runContractDigest, digestCanonicalJson(plan)],
    ['execution-bundle', execution.bundleDigest, digestCanonicalJson(execution)],
    ['evaluation-bundle', evaluation.bundleDigest, digestCanonicalJson(evaluation)],
    ['analysis-bundle', analysis.bundleDigest, digestCanonicalJson(analysis)],
    ['evaluation-report', report.reportDigest, digestCanonicalJson(report)],
  ] as const;
  const reportBundles = report.bundles.map((reference) => [
    reference.bundleKind,
    reference.bundleDigest,
  ]);

  if (digestCanonicalJson(manifestPayload) !== manifestDigest
      || manifest.runContractDigest !== plan.digests.runContractDigest
      || manifest.reportId !== report.reportId
      || manifest.status.runStatus !== report.status.runStatus
      || manifest.status.evidenceStatus !== report.status.evidenceStatus
      || manifest.status.conclusionStatus !== report.status.conclusionStatus
      || manifest.replayability.execution !== execution.replayability
      || manifest.replayability.evaluation !== evaluation.replayability
      || execution.runContractDigest !== plan.digests.runContractDigest
      || execution.executionPlanDigest !== plan.digests.executionPlanDigest
      || evaluation.runContractDigest !== plan.digests.runContractDigest
      || evaluation.executionBundleDigest !== execution.bundleDigest
      || evaluation.evaluationPlanDigest !== plan.digests.evaluationPlanDigest
      || analysis.runContractDigest !== plan.digests.runContractDigest
      || analysis.evaluationBundleDigest !== evaluation.bundleDigest
      || analysis.analysisPlanDigest !== plan.digests.analysisPlanDigest
      || report.runContractDigest !== plan.digests.runContractDigest
      || canonicalizeJson(reportBundles) !== canonicalizeJson([
        ['execution', execution.bundleDigest],
        ['evaluation', evaluation.bundleDigest],
        ['analysis', analysis.bundleDigest],
      ])
      || manifest.documents.length !== references.length
      || manifest.documents.some((reference, index) => (
        reference.documentKind !== references[index][0]
        || reference.identityDigest !== references[index][1]
        || reference.documentDigest !== references[index][2]
      ))) {
    fail();
  }
}
