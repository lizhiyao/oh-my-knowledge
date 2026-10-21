import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { vi } from 'vitest';
import { ExtractionRunSchema } from '../../src/knowledge/extraction/runs.js';
import { freezeExtractionStudyCorpus, extractionStudyDigest } from '../../src/knowledge/extraction/study-corpus.js';
import { extractionStudyReviewTargets, type ExtractionStudyJudgeIdentity, type ExtractionStudyOutputReceipt, type ExtractionStudyReviewInput } from '../../src/knowledge/extraction/study-review.js';
import { checkWindowExtractionResponse } from '../../src/knowledge/extraction/window-proposals.js';
import { SINGLE_EXTRACTION_POLICY } from '../../src/knowledge/extraction/generation-policy.js';
import { modelWindow, wireModelWindow } from './fixtures.js';
import { prepareExtractionStudy, replayExtractionStudyEvidence, runExtractionStudySlot } from '../../src/knowledge/application/study-runner.js';
import { createExtractionStudyPorts } from '../../src/knowledge/application/study-local.js';
import { ExtractionStudyFiles } from '../../src/knowledge/adapters/study-files.js';
import { configuredExtractionModel } from '../../src/knowledge/adapters/executor.js';
import { createOpenAiArchiveProducer } from '../../src/executors/openai/archive.js';
import { buildOpenAiChatRequest } from '../../src/executors/openai/request.js';
import type { ExecResult } from '../../src/executors/contracts/result.js';

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

export function studyNativeResult(output: string | null, changes: Partial<ExecResult> = {}): ExecResult {
  return { ok: true, output, durationMs: 5, durationApiMs: 0, inputTokens: 7, outputTokens: 4, cacheReadTokens: 2, cacheCreationTokens: 0,
    costUSD: 0, costReportedByExecutor: false, tokenUsageReportedByExecutor: true, stopReason: 'stop', numTurns: 1, attemptCount: 1, ...changes };
}

/** The caller owns an explicit temporary root and cleanup. Production adapters receive authored returns only. */
export function nativeStudyFixture(root: string, reply?: (index: number, output: string) => ExecResult) {
  const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const source = join(root, 'source.jsonl');
  writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
  let index = 0;
  const effects = vi.fn(async (input: { prompt: string }) => {
    const ref = JSON.parse(input.prompt).excerpts[0].evidenceRef;
    const output = JSON.stringify(wireModelWindow()).replaceAll('record-1', ref);
    return reply ? reply(index++, output) : studyNativeResult(output);
  });
  const producer = createOpenAiArchiveProducer({ NODE_ENV: 'test', OPENAI_API_KEY: 'authored-test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1' }, (_executor, options) => async input => {
    options.apiDispatchPolicy.beforeDispatch(buildOpenAiChatRequest(input, options.env, options.apiDispatchPolicy.requestConstraints));
    return effects(input);
  });
  const model = () => configuredExtractionModel('openai-api', 'authored-loopback-test', producer, { maxOutputTokens: 64 });
  const digest = extractionStudyDigest('authored runtime identity; not a measured host');
  const identity = () => ({ runtimeDigest: digest, dependencyDigest: digest, runnerDigest: digest, nodeVersion: 'authored-node', nodeBinaryDigest: digest });
  const ports = createExtractionStudyPorts({ workspace, actor: { actorKind: 'agent', actorId: 'authored-study-test', executionRef: 'authored-study-runner-test' }, identity, model });
  const window = ports.application.capture({ path: source });
  const corpus = freezeExtractionStudyCorpus({ corpusVersion: 'omk-extraction-study-corpus/v1', sourceKind: 'private-real', authors: ['authored-author'], cases: [{
    caseId: 'case-a', split: 'development', exposure: 'seen', projectGroup: 'p', conversationGroup: 'c', lineageGroup: 'l', ancestorLineageIds: [],
    stratumId: 'work-record', originDigest: digest, transformation: 'Authored regression source, not an independent real sample.',
    sourceRecords: window.records.map(value => ({ recordIndex: value.recordIndex, recordId: `authored:${value.recordIndex}`, originalDigest: extractionStudyDigest(value.raw) })), window,
    reference: { annotationScope: 'unannotated', entities: [], mentions: [], knowledge: [], semanticChecks: [] },
  }] });
  const corpusRaw = JSON.stringify(corpus), configurationRaw = '{}';
  const prepare = (extra: Partial<Parameters<typeof prepareExtractionStudy>[1]> = {}) => prepareExtractionStudy(ports, {
    corpus, corpusBytesDigest: hash(corpusRaw), configurationDigest: hash(configurationRaw), split: 'development', repeats: 1, changedVariable: 'replication',
    criteria: { maxConfirmedErrors: 0, confirmedErrorsRationale: 'Authored regression; no errors allowed.', maxRequiredGaps: 0, requiredGapsRationale: 'Authored regression; no missing required evidence.' },
    sampling: { selectionFrame: 'Authored test-only source, not real quality evidence.', inclusionExclusion: 'One authored source selected before outputs.',
      unit: 'lineage-group' as const, strata: [{ stratumId: 'work-record', coverageRationale: 'Exercise controlled native capture only.' }],
      sampleSizeRationale: 'One source tests invariants; no statistical quality claim.', stoppingRule: 'Execute declared slots; unknown reservation stops further effects.',
      budgetRationale: 'Each authored test uses the production declared invocation policy.', interruptionPolicy: 'Persist unknown; never repeat a started run.' },
    variants: [{ variantId: 'baseline', model: model(), policy: SINGLE_EXTRACTION_POLICY }, { variantId: 'candidate', model: model(), policy: SINGLE_EXTRACTION_POLICY }], ...extra,
  });
  const files = new ExtractionStudyFiles({ directory: join(root, 'study'), workspace, repository: resolve('.') });
  return { root, workspace, ports, effects, corpus, corpusRaw, configurationRaw, prepare, files, model };
}

/** Saved production bytes plus fictional review receipts; never an actual human, model or quality study. */
export async function nativeStudyEvidenceFixture(root: string, options: {
  annotated?: boolean; runSlots?: number; reply?: Parameters<typeof nativeStudyFixture>[1]; withoutCompletedFinish?: boolean;
} = {}) {
  const f = nativeStudyFixture(root, options.reply), { corpusDigest: _digest, ...body } = f.corpus; void _digest;
  if (options.annotated) {
    const evidenceRef = body.cases[0].window.excerpts[0].evidenceRef;
    body.cases[0].reference = { annotationScope: 'full',
      entities: ['Alpha', 'Beta'].map((quote, index) => ({ referenceId: `entity-${index}`, description: quote, equivalentExpressions: [quote], locators: [{ evidenceRef, quote }] })),
      mentions: ['Alpha', 'Beta'].map((quote, index) => ({ referenceId: `mention-${index}`, entityReferenceId: `entity-${index}`,
        description: quote, equivalentExpressions: [quote], locators: [{ evidenceRef, quote }] })),
      knowledge: [{ referenceId: 'usage', description: 'Authored Alpha uses Beta.', equivalentExpressions: ['使用'], coverage: 'required', locators: [{ evidenceRef, quote: 'Alpha 使用 Beta' }] }],
      semanticChecks: [] };
  }
  const corpus = freezeExtractionStudyCorpus(body), corpusRaw = JSON.stringify(corpus);
  const plan = f.prepare({ corpus, corpusBytesDigest: `sha256:${createHash('sha256').update(corpusRaw).digest('hex')}` });
  f.files.create(plan, corpusRaw, f.configurationRaw);
  const reviewedBeforeOutputs = new Date(Date.now() - 60_000).toISOString();
  for (const slot of plan.slots.slice(0, options.runSlots ?? plan.slots.length)) await runExtractionStudySlot(f.ports, { plan, corpus, slotId: slot.slotId });
  const evidence = f.files.evidence(plan);
  // An authored legacy-v5 portable fixture only: original production files remain unchanged.
  if (options.withoutCompletedFinish) for (const record of evidence.records) {
    const run = JSON.parse(record.raw);
    if (run.status === 'completed') { delete run.finishedAt; record.raw = JSON.stringify(run); }
  }
  const report = replayExtractionStudyEvidence(evidence, f.ports.identity());
  const authorReceipt = { reviewVersion: 'omk-extraction-study-reference-review/v1', corpusDigest: corpus.corpusDigest,
    reviewer: { actorKind: 'agent', actorId: 'authored-author' }, reviewRole: 'author', independentHuman: false,
    reviewedBeforeOutputs: true, reviewedAt: reviewedBeforeOutputs,
    decisions: [{ caseId: 'case-a', verdict: 'approved', rationale: 'Fictional authored test judgment; no human review occurred.' }], disputes: [] };
  const referenceReceipt = { ...authorReceipt, reviewer: { actorKind: 'human', actorId: 'fictional-independent-reference-reader' }, reviewRole: 'independent', independentHuman: true };
  const outputReceipt: ExtractionStudyOutputReceipt = { reviewVersion: 'omk-extraction-study-output-review/v1', planId: plan.planId, outputDigest: report.outputDigest,
    reviewer: { actorKind: 'human', actorId: 'fictional-independent-output-reader' }, independentHuman: true, reviewedAt: new Date().toISOString(),
    decisions: extractionStudyReviewTargets({ corpus, slots: report.slots }).map(target => {
      const run = report.slots.find(slot => slot.slotId === target.slotId)!.run;
      const quote = target.itemKind === 'entity' ? run?.entityAnalysis?.revision.entities.find(entity => entity.entityId === target.entityId)?.label
        : target.itemKind === 'mention' ? run?.entityAnalysis?.revision.mentions.find(mention => mention.mentionId === target.mentionId)?.selection.quote : undefined;
      const referenceId = !options.annotated ? null : target.itemKind === 'entity' ? `entity-${['Alpha', 'Beta'].indexOf(quote ?? '')}`
        : target.itemKind === 'mention' ? `mention-${['Alpha', 'Beta'].indexOf(quote ?? '')}` : target.itemKind === 'statement' ? 'usage' : null;
      return { target, verdict: run?.status === 'completed' ? 'correct' : ['reference_entity', 'reference_mention', 'knowledge_obligation'].includes(target.itemKind) ? 'required_missing' : 'uncertain',
        referenceId, errorCodes: [], rationale: 'Fictional authored test judgment; no human or model made this decision.' };
    }) };
  const judgeReceipt: ExtractionStudyOutputReceipt = { ...structuredClone(outputReceipt), reviewer: { actorKind: 'agent', actorId: 'authored-agent-judge' },
    independentHuman: false, judgeIdentity: studyJudgeIdentity() };
  return { ...f, plan, corpus, corpusRaw, evidence, report, authorReceipt, referenceReceipt, outputReceipt, judgeReceipt };
}
