import {
  type SealedRunPlan,
} from '../../eval-core/compiler/index.js';
import {
  type AuthenticatedEvaluationRunSources,
  type AdvancedPreparedEvaluation as CoreAdvancedPreparedEvaluation,
  type EvaluationRunResult,
  getAuthenticatedEvaluationRunSources,
} from '../../eval-core/engine/index.js';
import {
  type EvaluationResult,
  type PreparedEvaluationPlan,
  type PreparedEvaluation,
} from './contracts.js';
import {
  compareStrings,
} from './ordering.js';

export interface AuthenticatedCanonicalRun {
  readonly plan: SealedRunPlan;
  readonly sources: AuthenticatedEvaluationRunSources;
}

export const authenticatedCanonicalRuns = new WeakMap<object, AuthenticatedCanonicalRun>();

export const corePreparedEvaluations = new WeakMap<object, CoreAdvancedPreparedEvaluation>();

function hasExactArtifactSlot(
  artifacts: Readonly<Record<string, unknown>>,
  key: 'execution' | 'evaluation' | 'analysis' | 'decision',
  expected: unknown,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(artifacts, key);
  return expected === undefined
    ? descriptor === undefined
    : descriptor !== undefined
      && descriptor.enumerable === true
      && 'value' in descriptor
      && descriptor.value === expected;
}

/** @internal Returns the sealed contract only for a complete, restorable canonical result. */
export function getRestorableEvaluationResultPlanDigest(
  result: EvaluationResult,
): PreparedEvaluationPlan['digests']['runContractDigest'] | undefined {
  const authenticated = authenticatedCanonicalRuns.get(result);
  const artifacts = result.artifacts;
  const sources = authenticated?.sources;
  const artifactRecord = artifacts as Readonly<Record<string, unknown>> | undefined;
  const expectedArtifactKeys = sources?.decision === undefined ? 3 : 4;
  return authenticated !== undefined
      && sources?.execution !== undefined
      && sources.evaluation !== undefined
      && sources.analysis !== undefined
      && artifactRecord !== undefined
      && Object.keys(artifactRecord).length === expectedArtifactKeys
      && hasExactArtifactSlot(artifactRecord, 'execution', sources.execution.bundle)
      && hasExactArtifactSlot(artifactRecord, 'evaluation', sources.evaluation.bundle)
      && hasExactArtifactSlot(artifactRecord, 'analysis', sources.analysis.bundle)
      && hasExactArtifactSlot(artifactRecord, 'decision', sources.decision?.result)
      && result.report !== undefined
    ? authenticated.plan.digests.runContractDigest
    : undefined;
}

/** @internal Returns the sealed contract only for a capability created by this Runtime. */
export function getPreparedEvaluationPlanDigest(
  prepared: PreparedEvaluation,
): PreparedEvaluationPlan['digests']['runContractDigest'] | undefined {
  return corePreparedEvaluations.get(prepared)?.plan.digests.runContractDigest;
}

export function attachDefinition(
  result: EvaluationRunResult,
  runId: string,
  plan: PreparedEvaluationPlan,
): EvaluationResult {
  if (result.artifacts !== undefined) Object.freeze(result.artifacts);
  const records = result.artifacts?.analysis?.records ?? [];
  const analysisResults = Object.freeze(Object.fromEntries(
    [...records]
      .sort((left, right) => compareStrings(left.resultId, right.resultId))
      .map((record) => [record.resultId, record]),
  ));
  const attached = Object.freeze({
    ...result,
    runId,
    definition: plan.definition,
    policy: plan.measurementPolicy,
    analysisResults,
  });
  const sources = getAuthenticatedEvaluationRunSources(result);
  if (sources !== undefined) {
    authenticatedCanonicalRuns.set(attached, Object.freeze({ plan, sources }));
  }
  return attached;
}
