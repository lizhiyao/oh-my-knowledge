import { randomUUID } from 'node:crypto';
import { ExtractionRunSchema } from '../../src/knowledge/extraction/runs.js';
import { freezeExtractionStudyCorpus, extractionStudyDigest } from '../../src/knowledge/extraction/study-corpus.js';
import { extractionStudyReviewTargets, type ExtractionStudyJudgeIdentity, type ExtractionStudyOutputReceipt, type ExtractionStudyReviewInput } from '../../src/knowledge/extraction/study-review.js';
import { checkWindowExtractionResponse } from '../../src/knowledge/extraction/window-proposals.js';
import { SINGLE_EXTRACTION_POLICY } from '../../src/knowledge/extraction/generation-policy.js';
import { modelWindow } from './fixtures.js';

/** Authored unit data only. Fictional human receipts test gates and are never measurement evidence. */
export function studyFixture(negative = false) {
  const sha = extractionStudyDigest('authored fixture; never provider or human evidence');
  const window = { snapshotId: randomUUID(), sourceKind: 'codex' as const, sourcePath: '/authored/study.jsonl', sourceVersion: sha,
    projectionVersion: 'knowledge-window-v2' as const, capturedAt: '2020-01-01T00:00:00Z', startRecord: 0, endRecord: 0,
    limitations: ['Authored source for unit tests, not a real study.'], records: [{ recordIndex: 0, raw: 'Alpha 使用 Beta' }],
    excerpts: [{ evidenceRef: 'record-1', recordIndex: 0, eventKind: 'message', role: 'user', text: 'Alpha 使用 Beta' }] };
  const entityIds: string[] = [randomUUID(), randomUUID()], mentionIds: string[] = [randomUUID(), randomUUID()];
  const packet = negative ? { responseKind: 'knowledge-extraction', schemaVersion: 4, entities: [], mentions: [], proposals: [] }
    : JSON.parse(JSON.stringify(modelWindow()).replaceAll('"project"', JSON.stringify(entityIds[0])).replaceAll('"tool"', JSON.stringify(entityIds[1]))
      .replaceAll('"m1"', JSON.stringify(mentionIds[0])).replaceAll('"m2"', JSON.stringify(mentionIds[1])));
  const checked = checkWindowExtractionResponse(packet, window.excerpts);
  const corpus = freezeExtractionStudyCorpus({ corpusVersion: 'omk-extraction-study-corpus/v1', sourceKind: 'private-real', authors: ['author'],
    cases: [{ caseId: 'case-a', split: 'development', exposure: 'seen', projectGroup: 'project-a', conversationGroup: 'conversation-a', lineageGroup: 'lineage-a',
      ancestorLineageIds: [], stratumId: 'work-record', originDigest: sha, transformation: 'Authored test source; not an actual real input.',
      sourceRecords: [{ recordIndex: 0, recordId: 'original-a:0', originalDigest: sha }], window,
      reference: { annotationScope: 'full', entities: negative ? [] : ['Alpha', 'Beta'].map((quote, index) => ({ referenceId: `entity-${index}`, description: `Object ${quote}`,
        equivalentExpressions: [quote], locators: [{ evidenceRef: 'record-1', quote }] })),
      mentions: negative ? [] : ['Alpha', 'Beta'].map((quote, index) => ({ referenceId: `mention-${index}`, entityReferenceId: `entity-${index}`,
        description: `Exact ${quote} mention`, equivalentExpressions: [quote], locators: [{ evidenceRef: 'record-1', quote }] })),
      knowledge: negative ? [] : [{ referenceId: 'usage', description: 'Alpha uses Beta.', equivalentExpressions: ['使用'], coverage: 'required',
        locators: [{ evidenceRef: 'record-1', quote: 'Alpha 使用 Beta' }] }], semanticChecks: [{ checkId: 'source-attribution', description: 'Preserve source attribution and qualifiers.' }] } }] });
  const slots = ['baseline', 'candidate'].map(variantId => {
    const runId = randomUUID(), attemptId = randomUUID(), entityRevisionId = randomUUID(), actor = { actorKind: 'agent' as const, actorId: 'extractor:authored', executionRef: runId };
    const intents = checked.accepted.map(proposal => {
      const knowledgeId = randomUUID(), revisionId = randomUUID();
      return { requestId: randomUUID(), revision: { ...proposal.draft, knowledgeId, revisionId, observationRefs: [], derivations: [],
        createdAt: '2020-02-01T00:00:00Z', revisedAt: '2020-02-01T00:00:00Z', createdBy: actor, revisedBy: actor, revisionReason: 'Authored test birth.' },
      grounding: { revisionId, mentions: proposal.mentions, citations: proposal.citations, reuseRationale: proposal.reuseRationale, identityUncertainties: [],
        entityAnalysisRef: { analysisId: runId, revisionId: entityRevisionId },
        sourceBindings: [{ snapshotId: window.snapshotId, sourceVersion: sha, evidenceRefs: ['record-1'] }] } };
    });
    const run = ExtractionRunSchema.parse({ runKind: 'knowledge-extraction-run', schemaVersion: 5, runId, requestDigest: sha, generation: 1,
      snapshotId: window.snapshotId, sourceVersion: sha, executor: 'authored', model: 'fixture', promptVersion: 'knowledge-extraction-v18', promptHash: sha, inputDigest: sha,
      actor: { actorKind: 'agent', actorId: 'test-agent', executionRef: runId }, policy: SINGLE_EXTRACTION_POLICY,
      attempts: [{ attemptId, startedAt: '2020-02-01T00:00:00Z', requestDigest: sha,
        request: { systemDigest: sha, inputDigest: sha, outputMode: 'prompt-json', timeoutMs: 1000 },
        producer: { producerId: 'authored-unit-fixture', producerRevision: sha, sourceChannels: [{ channel: 'fixture', maxBytes: 4096 }], maxOutcomeJsonBytes: 8192, proof: { scope: 'authored-test-only' } },
        outcome: { bytes: 10, digest: sha } }], selectedAttemptId: attemptId, startedAt: '2020-02-01T00:00:00Z', finishedAt: '2020-02-02T00:00:00Z',
      status: 'completed', rawOutput: JSON.stringify(packet), rejections: [], entityRejections: [],
      entityAnalysis: { requestId: randomUUID(), analysisId: runId, snapshotId: window.snapshotId, sourceVersion: sha, expectedGeneration: 0, expectedHeadRevisionId: null,
        revision: { revisionId: entityRevisionId, revisedAt: '2020-02-01T00:00:00Z', revisedBy: actor, revisionReason: 'Authored test birth.',
          entities: checked.analysis.entities, mentions: checked.analysis.mentions, limitations: [] } },
      intents, committed: intents.map(value => ({ knowledgeId: value.revision.knowledgeId, revisionId: value.revision.revisionId })) });
    return { slotId: `${variantId}-case-a-1`, caseId: 'case-a', variantId, repeat: 1, run, nativeVerified: true };
  });
  const plan = { planId: sha, declaredAt: '2020-01-10T00:00:00Z', corpusDigest: corpus.corpusDigest, split: 'development' as const,
    caseIds: ['case-a'], variants: [{ variantId: 'baseline' }, { variantId: 'candidate' }], repeats: 1,
    slots: slots.map(slot => ({ slotId: slot.slotId, caseId: slot.caseId, variantId: slot.variantId, repeat: slot.repeat, runId: slot.run.runId })),
    criteria: { maxConfirmedErrors: 0, confirmedErrorsRationale: 'Authored regression admits no errors.', maxRequiredGaps: 0, requiredGapsRationale: 'Authored regression admits no missing obligations.' } };
  const authorReceipt = { reviewVersion: 'omk-extraction-study-reference-review/v1', corpusDigest: corpus.corpusDigest,
    reviewer: { actorKind: 'agent', actorId: 'author' }, reviewRole: 'author', independentHuman: false, reviewedBeforeOutputs: true,
    reviewedAt: '2020-01-20T00:00:00Z', decisions: [{ caseId: 'case-a', verdict: 'approved', rationale: 'Authored test approval, not human evidence.' }], disputes: [] };
  const referenceReceipt = { ...authorReceipt, reviewer: { actorKind: 'human', actorId: 'fictional-independent-reader' }, reviewRole: 'independent', independentHuman: true };
  const input: ExtractionStudyReviewInput = { plan, corpus, slots, outputDigest: sha, integrity: { planVerified: true, outputVerified: true },
    authorReceipt, referenceReceipt, now: '2020-04-01T00:00:00Z' };
  const receipt: ExtractionStudyOutputReceipt = { reviewVersion: 'omk-extraction-study-output-review/v1', planId: plan.planId, outputDigest: sha,
    reviewer: { actorKind: 'human', actorId: 'fictional-independent-output-reader' }, independentHuman: true, reviewedAt: '2020-03-01T00:00:00Z',
    decisions: extractionStudyReviewTargets(input).map(target => ({ target, verdict: 'correct',
      referenceId: target.itemKind === 'entity' ? `entity-${entityIds.indexOf(target.entityId)}`
        : target.itemKind === 'mention' ? `mention-${mentionIds.indexOf(target.mentionId)}` : target.itemKind === 'statement' ? 'usage' : null,
      errorCodes: [], rationale: 'Fictional authored judgment solely exercises gate logic; no human review occurred.' })) };
  input.outputReceipt = receipt;
  return { input, receipt, corpus, plan, slots, authorReceipt, referenceReceipt };
}

/** Fictional judge declarations exercise accounting only; no model or human produced these artifacts. */
export function studyJudgeIdentity(): ExtractionStudyJudgeIdentity {
  const evidence = (name: string) => ({ reference: `authored-unit-fixture:${name}`, digest: extractionStudyDigest(name) });
  return { identityVersion: 'omk-extraction-study-judge-identity/v1', evidenceScope: 'reviewer-declared;not-native-verified/v1',
    executor: 'authored-judge', executorRevision: 'authored-executor-r1', model: 'authored-model', modelRevision: 'authored-model-r1',
    promptVersion: 'authored-judge-prompt/v1', promptDigest: extractionStudyDigest('authored judge prompt bytes'),
    configurationDigest: extractionStudyDigest('authored judge configuration'), selectedAttemptId: 'authored-judge-attempt-1',
    attempts: [{ attemptId: 'authored-judge-attempt-1', attemptStatus: 'completed', runEvidence: evidence('judge-run'), outputEvidence: evidence('judge-output'),
      usage: { durationMs: null, inputTokens: null, outputTokens: null, costUSD: null } }] };
}
