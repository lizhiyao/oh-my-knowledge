import { z } from 'zod';
import { extractionStudyHostIdentity } from '../adapters/study-host.js';
import { replayExtractionStudyEvidence } from './study-runner.js';
import { parseExtractionStudyPlan } from '../extraction/study-plan.js';
import { parseExtractionStudyCorpus } from '../extraction/study-corpus.js';
import { analyzeExtractionStudy, calibrateExtractionStudyJudge } from '../extraction/study-analysis.js';
import { evaluateExtractionStudyReview, type ExtractionStudyJudgeIdentity } from '../extraction/study-review.js';
import { EXTRACTION_STUDY_INSPECTION_MAX_BYTES } from '../extraction/study-capacity.js';

const requestSchema = z.strictObject({ evidence: z.unknown(), authorReceipt: z.unknown().optional(),
  referenceReceipt: z.unknown().optional(), outputReceipt: z.unknown().optional(), judgeReceipt: z.unknown().optional() });
type InspectionCode = 'knowledge_study_input_invalid' | 'knowledge_study_capacity_exceeded'
  | 'knowledge_study_host_mismatch' | 'knowledge_study_evidence_invalid';
export class ExtractionStudyInspectionError extends Error {
  constructor(readonly code: InspectionCode) { super(code); this.name = 'ExtractionStudyInspectionError'; }
}

/** Model identity and accounting remain visible; local artifact references never enter product DTOs. */
function judgeIdentity(identity: ExtractionStudyJudgeIdentity | null) {
  return identity && { identityVersion: identity.identityVersion, evidenceScope: identity.evidenceScope,
    executor: identity.executor, executorRevision: identity.executorRevision, model: identity.model, modelRevision: identity.modelRevision,
    promptVersion: identity.promptVersion, promptDigest: identity.promptDigest, configurationDigest: identity.configurationDigest,
    selectedAttemptId: identity.selectedAttemptId, attempts: identity.attempts.map(attempt => ({ attemptId: attempt.attemptId,
      attemptStatus: attempt.attemptStatus, runEvidence: { digest: attempt.runEvidence.digest },
      outputEvidence: attempt.outputEvidence && { digest: attempt.outputEvidence.digest }, usage: attempt.usage })) };
}

function reviewProjection(review: ReturnType<typeof evaluateExtractionStudyReview>) {
  return { reportVersion: review.reportVersion, reportId: review.reportId, planId: review.planId, corpusDigest: review.corpusDigest,
    outputDigest: review.outputDigest, scope: review.scope, status: review.status, reference: review.reference,
    releaseEligibility: review.releaseEligibility, remainingRequirements: review.remainingRequirements,
    outputReview: { reviewer: review.outputReview.reviewer, independentHuman: review.outputReview.independentHuman,
      reviewedAt: review.outputReview.reviewedAt, judgeIdentity: judgeIdentity(review.outputReview.judgeIdentity),
      expected: review.outputReview.expected, reviewed: review.outputReview.reviewed, confirmedErrors: review.outputReview.confirmedErrors,
      requiredGaps: review.outputReview.requiredGaps, uncertain: review.outputReview.uncertain },
    countingUnit: review.countingUnit, targets: review.targets, decisions: review.decisions, missingTargets: review.missingTargets,
    forcedBlockingErrors: review.forcedBlockingErrors, blockers: review.blockers, slots: review.slots, variants: review.variants, limits: review.limits };
}

function elapsed(startedAt?: string, finishedAt?: string) {
  if (!startedAt) return { elapsedMs: null, elapsedStatus: 'unattempted' as const };
  if (!finishedAt) return { elapsedMs: null, elapsedStatus: 'unfinished' as const };
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isSafeInteger(duration) && duration >= 0 ? { elapsedMs: duration, elapsedStatus: 'observed' as const }
    : { elapsedMs: null, elapsedStatus: 'invalid_clock_interval' as const };
}

/** Read only portable bytes with this installed checker; no workspace, model, environment or caller trust flags. */
export function inspectExtractionStudy(input: unknown) {
  let request: z.infer<typeof requestSchema>;
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) throw new Error();
    if (Buffer.byteLength(serialized, 'utf8') > EXTRACTION_STUDY_INSPECTION_MAX_BYTES) throw new ExtractionStudyInspectionError('knowledge_study_capacity_exceeded');
    request = requestSchema.parse(JSON.parse(serialized));
    if (request.evidence === undefined) throw new Error();
  } catch (cause) {
    if (cause instanceof ExtractionStudyInspectionError) throw cause;
    throw new ExtractionStudyInspectionError('knowledge_study_input_invalid');
  }
  let host: ReturnType<typeof extractionStudyHostIdentity>;
  try { host = extractionStudyHostIdentity(); }
  catch { throw new ExtractionStudyInspectionError('knowledge_study_host_mismatch'); }
  try {
    const replay = replayExtractionStudyEvidence(request.evidence, host);
    // Successful replay has already validated the complete portable envelope and original JSON bytes.
    const portable = z.object({ plan: z.unknown(), corpusRaw: z.string() }).parse(request.evidence);
    const plan = parseExtractionStudyPlan(portable.plan), corpus = parseExtractionStudyCorpus(JSON.parse(portable.corpusRaw));
    const reviewInput = { plan, corpus, slots: replay.slots, outputDigest: replay.outputDigest, integrity: replay.integrity,
      authorReceipt: request.authorReceipt, referenceReceipt: request.referenceReceipt, outputReceipt: request.outputReceipt,
      now: new Date().toISOString() };
    const analysis = analyzeExtractionStudy(reviewInput), review = evaluateExtractionStudyReview(reviewInput);
    const judgeReview = request.judgeReceipt === undefined ? null : evaluateExtractionStudyReview({ ...reviewInput, outputReceipt: request.judgeReceipt });
    if (judgeReview && judgeReview.outputReview.reviewer?.actorKind !== 'agent') throw new ExtractionStudyInspectionError('knowledge_study_evidence_invalid');
    const calibrated = request.judgeReceipt === undefined ? null : calibrateExtractionStudyJudge({ ...reviewInput,
      judgeReceipt: request.judgeReceipt, humanReceipt: request.outputReceipt });
    return { inspectionVersion: 'omk-extraction-study-inspection/v1' as const, modelCallsByThisCommand: 0 as const,
      plan: { planVersion: plan.planVersion, planId: plan.planId, corpusDigest: plan.corpusDigest, declaredAt: plan.declaredAt,
        split: plan.split, caseIds: plan.caseIds, repeats: plan.repeats, changedVariable: plan.changedVariable, orderPolicy: plan.orderPolicy,
        criteria: plan.criteria, sampling: plan.sampling, host: plan.host,
        variants: plan.variants.map(variant => ({ variantId: variant.variantId, executor: variant.executor, model: variant.model,
          policy: variant.policy, promptVersion: variant.promptProfile.promptVersion,
          promptDigest: plan.slots.find(slot => slot.variantId === variant.variantId)!.request.systemDigest,
          outputMode: variant.outputMode, wireId: variant.wireId, timeoutMs: variant.timeoutMs, maxOutputTokens: variant.maxOutputTokens })) },
      summary: replay.summary, analysis,
      review: reviewProjection(review), judgeReview: judgeReview && reviewProjection(judgeReview),
      calibration: calibrated && { calibrationVersion: calibrated.calibrationVersion, planId: calibrated.planId, outputDigest: calibrated.outputDigest,
        ready: calibrated.ready, reasons: calibrated.reasons, judgeReviewReportId: calibrated.judgeReviewReportId, humanReviewReportId: calibrated.humanReviewReportId,
        judgeEvidence: { identity: judgeIdentity(calibrated.judgeEvidence.identity), evidenceStatus: calibrated.judgeEvidence.evidenceStatus,
          nativeVerification: calibrated.judgeEvidence.nativeVerification, declaredAttemptCount: calibrated.judgeEvidence.declaredAttemptCount,
          usage: calibrated.judgeEvidence.usage }, status: calibrated.status, countingUnit: calibrated.countingUnit,
        judgeAcceptance: calibrated.judgeAcceptance, expectedTargets: calibrated.expectedTargets, knownComparedTargets: calibrated.knownComparedTargets,
        unknownOrMissingTargets: calibrated.unknownOrMissingTargets, byClass: calibrated.byClass, criticalMisses: calibrated.criticalMisses,
        confidenceInterval: calibrated.confidenceInterval, confidenceIntervalReason: calibrated.confidenceIntervalReason, limits: calibrated.limits },
      cases: corpus.cases.filter(sample => plan.caseIds.includes(sample.caseId)).map(sample => ({ caseId: sample.caseId,
        split: sample.split, exposure: sample.exposure, projectGroup: sample.projectGroup, conversationGroup: sample.conversationGroup,
        lineageGroup: sample.lineageGroup, ancestorLineageIds: sample.ancestorLineageIds, stratumId: sample.stratumId,
        originDigest: sample.originDigest, transformation: sample.transformation, reference: sample.reference,
        source: { snapshotId: sample.window.snapshotId, sourceKind: sample.window.sourceKind, sourceVersion: sample.window.sourceVersion,
          projectionVersion: sample.window.projectionVersion, capturedAt: sample.window.capturedAt,
          startRecord: sample.window.startRecord, endRecord: sample.window.endRecord, limitations: sample.window.limitations,
          excerpts: sample.window.excerpts } })),
      slots: replay.slots.map(slot => ({ slotId: slot.slotId, caseId: slot.caseId, variantId: slot.variantId, repeat: slot.repeat,
        runId: slot.run?.runId ?? null, status: slot.run?.status ?? 'unattempted' as const, nativeVerified: slot.nativeVerified,
        startedAt: slot.run?.startedAt ?? null, finishedAt: slot.run?.finishedAt ?? null, ...elapsed(slot.run?.startedAt, slot.run?.finishedAt),
        attempts: slot.attempts.map(attempt => ({ attemptId: attempt.attemptId, archiveStatus: attempt.archiveStatus, outcomeRef: attempt.ref,
          failureKind: slot.run?.attempts.find(value => value.attemptId === attempt.attemptId)?.failure?.failureKind ?? null })),
        birth: slot.run?.entityAnalysis ? { analysisId: slot.run.entityAnalysis.analysisId, revisionId: slot.run.entityAnalysis.revision.revisionId,
          entities: slot.run.entityAnalysis.revision.entities, mentions: slot.run.entityAnalysis.revision.mentions,
          limitations: slot.run.entityAnalysis.revision.limitations,
          knowledge: slot.run.intents.map(intent => ({ knowledgeId: intent.revision.knowledgeId, revisionId: intent.revision.revisionId,
            title: intent.revision.title, entities: intent.revision.entities, content: intent.revision.content, evidence: intent.revision.evidence,
            grounding: { mentions: intent.grounding.mentions, citations: intent.grounding.citations, reuseRationale: intent.grounding.reuseRationale,
              identityUncertainties: intent.grounding.identityUncertainties, entityAnalysisRef: intent.grounding.entityAnalysisRef,
              sourceBindings: intent.grounding.sourceBindings } })) } : null })),
      timing: { unit: 'milliseconds' as const, scope: 'local-run-wall-clock' as const,
        description: 'Run startedAt to finishedAt includes generation, archiving, writes and retry backoff; it is not active human review duration.' },
      limits: ['The selected portable evidence is inspected transiently; no workspace is read or written and no model is called.',
        'This installed runtime must match the frozen study host; caller statuses, integrity flags and ready claims are never accepted.',
        'Only source excerpts and birth projections are exposed; raw records, native outcomes, source paths and judge artifact references remain outside this DTO.',
        'Scoped judgments and judge identities remain reviewer declarations, not authenticated human identity, native judge verification or release acceptance.'],
    };
  } catch (cause) {
    if (cause instanceof ExtractionStudyInspectionError) throw cause;
    if (cause instanceof Error && cause.message === 'Portable study requires its frozen runtime and checker identity.') {
      throw new ExtractionStudyInspectionError('knowledge_study_host_mismatch');
    }
    throw new ExtractionStudyInspectionError('knowledge_study_evidence_invalid');
  }
}
export type ExtractionStudyInspection = ReturnType<typeof inspectExtractionStudy>;
