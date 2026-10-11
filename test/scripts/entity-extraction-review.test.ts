import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWindowExtractionResponse } from '../../src/observability/knowledge-extraction/window-proposals.js';
import { ENTITY_CHECK_VERSION, entityReviewInput, parseEntityReviewCorpus, reviewMentions, type EntityReviewCase } from '../../scripts/bench/entity-review-corpus.js';
import { checkEntityReview, reviewCapturedOutput } from '../../scripts/bench/entity-review-checks.js';
import { annotationReadiness, authorReviewStatus, entityReviewHtml, parseEntityReviewArguments, reviewCapture, reviewDigest, reviewReceiptStatus } from '../../scripts/bench/entity-extraction-review.js';
import { modelWindow } from '../knowledge/fixtures.js';

const corpusText = readFileSync(new URL('../fixtures/entity-extraction-review-v12.json', import.meta.url), 'utf8');
const corpus = parseEntityReviewCorpus(corpusText);
// Historical frozen data is audited as immutable shape, never accepted by the current reader.
const v11Text = readFileSync(new URL('../fixtures/entity-extraction-review-v11.json', import.meta.url), 'utf8');
const v11 = JSON.parse(v11Text) as typeof corpus;
const measurementId = reviewDigest('frozen measurement');
const sample: EntityReviewCase = {
  caseId: 'roles', projectGroup: 'project', conversationGroup: 'conversation', split: 'development',
  messages: [{ role: 'user', text: 'Alpha drives Beta.' }], limitations: ['Selected messages only.'], tags: ['roles'],
  entities: ['alpha', 'beta'].map(entityKey => ({ entityKey, referentKinds: ['object'], identityStatus: 'proposed', possibleEntities: [],
    component: null, collection: null, rationale: 'Distinct objects.' })),
  mentions: ['Alpha', 'Beta'].map(quote => ({ mentionKey: quote.toLowerCase(), entity: quote.toLowerCase(), messageIndex: 0,
    alternatives: [{ quote, occurrence: 0 }], rationale: 'Explicit name.' })),
  roles: [{ roleKey: 'drives', coverage: 'if_selected', subject: 'alpha', object: 'beta', messageIndex: 0,
    anchor: { quote: 'Alpha drives Beta.', occurrence: 0 }, interpretation: 'Alpha drives Beta; equivalent wording allowed.' }],
  knowledgePolicy: 'optional', semanticChecks: ['Verify meaning independently.'],
};
function packet() {
  const output = modelWindow();
  output.mentions.forEach(mention => { mention.selection.evidenceRef = 'roles:0'; });
  output.proposals[0].draft.evidence[0].evidenceRef = 'roles:0';
  output.proposals[0].citations[0].selection = { evidenceRef: 'roles:0', quote: 'Alpha drives Beta.' };
  return output;
}
const check = (response: unknown) => checkWindowExtractionResponse(response, entityReviewInput(sample).excerpts);
function receipt() {
  return { reviewVersion: 'omk-entity-annotation-review/v1', measurementId, reviewer: 'independent-reader', reviewedAt: '2020-01-01T00:00:00Z',
    reviewKind: 'independent-human', reviewedBeforeOutputs: true, independenceAttestation: true,
    decisions: corpus.cases.map(value => ({ caseId: value.caseId, decision: 'approved', rationale: 'Read sources and annotations; agree.' })), disputes: [] };
}

describe('entity extraction review with author evidence', () => {
  it('audits real regression provenance without publishing private text or hiding failed semantics behind replay', () => {
    type Counts = { entities: number; mentions: number; knowledgeCandidates: number; statements: number };
    const text = readFileSync(new URL('../../docs/public/entity-extraction-v11-real-regression.json', import.meta.url), 'utf8');
    const evidence = JSON.parse(text) as {
      conclusion: string; measurement: { measurementId: string; identity: {
        promptVersion: string; promptDigest: string; annotationDigest: string; runtimeDigest: string;
      }; goldReady: boolean; independentReview: string; windowMessages: number; uniqueMessages: number };
      capture: { status: string; modelCallsAuthorized: number; modelCallsExecuted: number; attempted: number; recorded: number; executorInvocations: number };
      totals: Record<string, number | string | null>;
      cases: { caseId: string; outputDigest: string; counts: Counts; programSemanticReview: string;
        usage: { costReportedByExecutor: boolean; costUSD: null; inputTokens: number; cacheReadTokens: number; outputTokens: number };
        selfReview: { reviewedCounts: Counts; independentHumanReview: string; goldReady: boolean;
          expectedObjects: { planned: number; found: number; consistentOnSelfReview: number };
          requiredKnowledgeRoles: { status: string; statementRefs: string[] }[]; issues: { issueKind: string; mentionId?: string }[] };
        applicationReplay: { originalOutputDigest: string; reopenedAllPayloadsMatch: boolean; allMentionsMatched: boolean } }[];
      localDriverCorrection: { originalDriverDigest: string; fixedDriverDigest: string; originalManifestDigest: string;
        originalDriverExitCode: number; actualModelCallsBeforeCorrection: number; newModelCallsForCorrection: number; outputDigest: string };
      applicationReplay: { externalModelCalls: number; recordedRunsReplayed: number; reopenedAllPayloadsMatch: boolean };
      historicalEvidence: { files: { file: string; digest: string }[]; syntheticV10Score: string; syntheticV11Score: string; syntheticV12FollowupScore: string };
      evidenceDigests: Record<string, string>; publication: Record<string, string>;
      overallPrecision: null; overallRecall: null; overallF1: null;
    };
    expect(reviewDigest(JSON.stringify(evidence.measurement.identity))).toBe(evidence.measurement.measurementId);
    expect(evidence.measurement.identity.promptVersion).toBe('knowledge-extraction-v11');
    // Historical evidence stays bound to its frozen prompt even after production moves to a later version.
    expect(evidence.measurement.identity.promptDigest).toBe(evidence.evidenceDigests['prompt.txt']);
    expect(evidence.measurement).toMatchObject({ goldReady: false, independentReview: 'not_performed', windowMessages: 9, uniqueMessages: 9 });
    expect(evidence.capture).toMatchObject({ status: 'stopped_on_self_review', modelCallsAuthorized: 2, modelCallsExecuted: 2, attempted: 2, recorded: 2, executorInvocations: 2 });
    expect(evidence.cases.map(item => item.caseId)).toEqual(['real-session-after-resolution', 'real-protected-correction']);
    for (const field of ['entities', 'mentions', 'knowledgeCandidates', 'statements'] as const) {
      expect(evidence.totals[field]).toBe(evidence.cases.reduce((count, item) => count + item.counts[field], 0));
    }
    for (const item of evidence.cases) {
      expect(item.selfReview.reviewedCounts).toEqual(item.counts);
      expect(item.selfReview).toMatchObject({ independentHumanReview: 'not_performed', goldReady: false });
      expect(item.programSemanticReview).toBe('pending');
      expect(item.usage).toMatchObject({ costReportedByExecutor: false, costUSD: null });
      expect(item.applicationReplay.originalOutputDigest).toBe(item.outputDigest);
      expect(item.applicationReplay.reopenedAllPayloadsMatch).toBe(true);
    }
    expect(evidence.totals).toMatchObject({ expectedObjectsPlanned: 13, expectedObjectsFound: 12,
      expectedObjectsConsistentOnSelfReview: 11, requiredKnowledgeRolesPlanned: 3,
      requiredKnowledgeRolesObservedOnSelfReview: 3, issuesOnSelfReview: 4, usdCost: 'unknown', reportedCostUSD: null });
    expect(evidence.cases.flatMap(item => item.selfReview.requiredKnowledgeRoles)
      .every(role => role.status === 'observed_consistent_on_self_review' && role.statementRefs.length > 0)).toBe(true);
    expect(evidence.cases[1].selfReview.issues).toContainEqual({ issueKind: 'source_mention_boundary_error', entityId: 'e6', mentionId: 'm11' });
    expect(evidence.conclusion).toBe('needs_improvement');
    // Replay preserves an exactly locatable but semantically wrong substring; this audit does not verify private semantics.
    expect(evidence.cases[1].applicationReplay.allMentionsMatched).toBe(true);
    expect(evidence.applicationReplay).toMatchObject({ externalModelCalls: 0, recordedRunsReplayed: 2, reopenedAllPayloadsMatch: true });
    const correction = evidence.localDriverCorrection;
    expect(correction).toMatchObject({ originalDriverExitCode: 1, actualModelCallsBeforeCorrection: 1, newModelCallsForCorrection: 0 });
    expect(correction.outputDigest).toBe(evidence.cases[0].outputDigest);
    expect(correction.originalDriverDigest).toBe(evidence.evidenceDigests['capture-real-followup.original.mjs']);
    expect(correction.fixedDriverDigest).toBe(evidence.evidenceDigests['capture-real-followup.mjs']);
    expect(correction.originalManifestDigest).toBe(evidence.evidenceDigests['manifest.first-driver-failure.original.json']);
    for (const prior of evidence.historicalEvidence.files) {
      expect(reviewDigest(readFileSync(new URL(`../../${prior.file}`, import.meta.url), 'utf8'))).toBe(prior.digest);
    }
    expect(evidence.historicalEvidence).toMatchObject({ syntheticV10Score: '10/13', syntheticV11Score: '2/3', syntheticV12FollowupScore: '6/6' });
    expect([evidence.overallPrecision, evidence.overallRecall, evidence.overallF1]).toEqual([null, null, null]);
    expect(evidence.publication).toMatchObject({ rawInputs: 'local_only', rawOutputs: 'local_only', annotations: 'local_only', originalPaths: 'not_published' });
    expect(text).not.toMatch(/\/private\/|\/Users\/|"(?:text|output|quote|rationale|sourceProvenance|selection)"\s*:/u);
  });

  it('replays the two authorized v12 follow-up outputs without pooling history or treating absent optional knowledge as a pass', () => {
    const evidence = JSON.parse(readFileSync(new URL('../../docs/public/entity-extraction-v12-followup-diagnostic.json', import.meta.url), 'utf8')) as {
      manifest: { measurementId: string; corpusDigest: string; guideDigest: string; promptHash: string };
      frozen: { identity: unknown; corpusFile: string; corpusDigest: string; guides: { en: string; zh: string };
        prompt: { version: string; prompt: string }; authorReview: unknown };
      preparedPlan: { text: string; digest: string };
      captures: ReturnType<typeof reviewCapture>['capture'][]; records: ReturnType<typeof reviewCapture>['records'];
      fullCorpusSplitSummaries: ReturnType<typeof reviewCapture>['summary'][];
      historicalEvidence: { digests: Record<string, string> };
      agentReview: { records: { caseId: string; outputDigest: string; reviewedEntityIds: string[]; reviewedMentionIds: string[];
        entityReviews: { entityId: string }[]; mentionReviews: { mentionId: string }[];
        roleReviews: { roleKey: string; coverage: string; status: string }[] }[] };
    };
    expect(evidence).toMatchObject({ goldReady: false, execution: { modelCallsAuthorized: 2, modelCallsExecuted: 2,
      executorInvocations: 2, maxCalls: 2, automaticRetries: 0, unattemptedCaseIds: [], unusedAuthorizedCalls: 0 },
    statistics: { uniqueOutputs: 2, checkedCriticalMentions: 6, matchedCriticalMentions: 6, identityPairsMatched: 7,
      acceptedEntities: 4, acceptedMentions: 7, acceptedProposals: 1, acceptedStatements: 2, requiredKnowledgeRolesSelfReviewed: 2,
      optionalKnowledgeRolesNotObserved: 1, usdCost: 'unknown' },
    historicalEvidence: { originalScores: { v10: '10/13', v11: '2/3' }, oldResultsUnchanged: true,
      oldMainOutputIncludedInNewScore: false, unusedPriorAuthorizationTransferred: false },
    offlineInspection: { modelCallsExecuted: 0, exitCodes: { development: 1, validation: 1 } } });
    expect(evidence.frozen.corpusFile).toBe('test/fixtures/entity-extraction-review-v12.json');
    const frozenText = readFileSync(new URL('../../' + evidence.frozen.corpusFile, import.meta.url), 'utf8');
    const frozen = JSON.parse(frozenText) as typeof corpus;
    expect(reviewDigest(frozenText)).toBe(evidence.manifest.corpusDigest);
    expect(evidence.frozen.corpusDigest).toBe(evidence.manifest.corpusDigest);
    expect(reviewDigest(JSON.stringify(evidence.frozen.identity))).toBe(evidence.manifest.measurementId);
    expect(reviewDigest(evidence.frozen.guides.en + '\0' + evidence.frozen.guides.zh)).toBe(evidence.manifest.guideDigest);
    expect(evidence.frozen.prompt.version).toBe('knowledge-extraction-v11');
    expect(reviewDigest(evidence.frozen.prompt.prompt)).toBe(evidence.manifest.promptHash);
    expect(authorReviewStatus(JSON.stringify(evidence.frozen.authorReview), frozen, evidence.manifest.measurementId).status).toBe('completed');
    expect(reviewDigest(evidence.preparedPlan.text)).toBe(evidence.preparedPlan.digest);
    expect(JSON.parse(evidence.preparedPlan.text)).toMatchObject({ maxCalls: 2, modelCallsAuthorized: 0, modelCallsExecuted: 0 });
    for (const [path, hash] of Object.entries(evidence.historicalEvidence.digests)) {
      expect(reviewDigest(readFileSync(new URL('../../' + path, import.meta.url), 'utf8'))).toBe(hash);
    }
    for (const [index, capture] of evidence.captures.entries()) {
      const replay = reviewCapture(JSON.stringify(capture), frozen, evidence.manifest.measurementId, checkWindowExtractionResponse);
      expect(JSON.parse(JSON.stringify(replay.summary))).toEqual(Object.fromEntries(Object.entries(evidence.fullCorpusSplitSummaries[index]).filter(([key]) => key !== 'split')));
      expect(replay.summary.captureStatus).toBe('incomplete');
      expect(replay.summary.semanticReview).toBe('pending');
      if (capture.split === 'development') expect(JSON.parse(JSON.stringify(replay.records))).toEqual(evidence.records);
      else expect(replay.records).toEqual([]);
    }
    expect(evidence.records.map(value => value.caseId)).toEqual(['held-config-literal-types', 'dev-keyboard-levels']);
    for (const record of evidence.records) {
      const review = evidence.agentReview.records.find(value => value.caseId === record.caseId)!;
      const capture = evidence.captures[0].records.find(value => value.caseId === record.caseId)!;
      if (capture.result.captureStatus !== 'output' || record.captureStatus !== 'captured' || !record.checked) throw new Error('Expected original captured output and admission');
      expect(review.outputDigest).toBe(reviewDigest(capture.result.output));
      expect(review.entityReviews.map(value => value.entityId)).toEqual(record.checked.analysis.entities.map(value => value.entityId));
      expect(review.mentionReviews.map(value => value.mentionId)).toEqual(record.checked.analysis.mentions.map(value => value.mentionId));
    }
    const keyboard = evidence.records[1];
    if (keyboard.captureStatus !== 'captured' || !keyboard.checked || !keyboard.checks) throw new Error('Expected captured keyboard entities');
    expect(keyboard.checked.accepted).toEqual([]);
    expect(keyboard.checks.unmatchedMentionsNeedReview).toEqual(['m4']);
    expect(keyboard.checks.knowledgeCoverage[0]).toMatchObject({ coverage: 'if_selected', status: 'not_observed', semanticReview: 'pending' });
    expect(evidence.agentReview.records[1].roleReviews).toMatchObject([{ roleKey: 'clean', coverage: 'if_selected', status: 'not_observed' }]);
    expect(evidence.fullCorpusSplitSummaries.map(value => value.notAttempted)).toEqual([56, 2]);
    expect(evidence.fullCorpusSplitSummaries.map(value => value.uncheckedCriticalMentions)).toEqual([189, 4]);
  });

  it('audits all source occurrences and admits qualified names without accepting claims, attributes or member lists', () => {
    const audit = JSON.parse(readFileSync(new URL('../../docs/public/entity-name-annotation-v12-audit.json', import.meta.url), 'utf8')) as {
      sourceCorpusDigest: string; corpusDigest: string; modelCallsExecuted: number; goldReady: boolean;
      statistics: { reviewedWindows: number; reviewedCriticalMentions: number; changedWindows: number; changedMentions: number; addedAlternatives: number };
      decisions: { caseId: string; split: string; sourceInputDigest: string; reviewedMentionKeys: string[]; reviewedEntityKeys: string[];
        changes: { mentionKey: string; added: { quote: string; occurrence: number; start: number; end: number }[] }[];
        rejectedCandidates: { mentionKey: string; quote: string; occurrence: number; start: number; end: number }[] }[];
    };
    expect(audit.sourceCorpusDigest).toBe(reviewDigest(v11Text)); expect(audit.corpusDigest).toBe(reviewDigest(corpusText));
    expect(audit.modelCallsExecuted).toBe(0); expect(audit.goldReady).toBe(false);
    expect(audit.statistics).toEqual({ reviewedWindows: 60, reviewedCriticalMentions: 199, changedWindows: 19,
      changedMentions: 26, addedAlternatives: 32, rejectedCandidates: 60 });
    expect(audit.decisions.map(value => value.caseId)).toEqual(corpus.cases.map(value => value.caseId));
    expect(() => parseEntityReviewCorpus(v11Text)).toThrow();
    for (const sample of corpus.cases) {
      const old = v11.cases.find(value => value.caseId === sample.caseId)!;
      const decision = audit.decisions.find(value => value.caseId === sample.caseId)!;
      expect(entityReviewInput(sample)).toEqual(entityReviewInput(old));
      expect(sample.entities).toEqual(old.entities); expect(sample.roles).toEqual(old.roles);
      expect(sample.semanticChecks).toEqual(old.semanticChecks); expect(sample.split).toBe(old.split);
      expect(decision.sourceInputDigest).toBe(reviewDigest(JSON.stringify({ messages: sample.messages, limitations: sample.limitations })));
      expect(decision.reviewedMentionKeys).toEqual(sample.mentions.map(value => value.mentionKey));
      expect(decision.reviewedEntityKeys).toEqual(sample.entities.map(value => value.entityKey));
      for (const mention of sample.mentions) {
        const prior = old.mentions.find(value => value.mentionKey === mention.mentionKey)!;
        const additions = decision.changes.find(value => value.mentionKey === mention.mentionKey)?.added ?? [];
        expect(mention.alternatives).toEqual([...prior.alternatives, ...additions.map(({ quote, occurrence }) => ({ quote, occurrence }))]);
        expect({ ...mention, alternatives: prior.alternatives, rationale: prior.rationale }).toEqual(prior);
      }
      const admission = (mentionKey: string, selection: { quote: string; occurrence: number }) => {
        const mention = sample.mentions.find(value => value.mentionKey === mentionKey)!;
        const output = modelWindow(); output.proposals = [];
        output.entities = [{ ...output.entities[0], entityId: mention.entity, label: mention.entity }];
        output.mentions = [{ mentionId: 'boundary', entityId: mention.entity, basis: 'explicit', rationale: 'Synthetic source-boundary probe, not model output.',
          selection: { evidenceRef: `${sample.caseId}:${mention.messageIndex}`, quote: selection.quote, occurrence: selection.occurrence } }];
        return checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
      };
      for (const change of decision.changes) for (const added of change.added) {
        const admitted = admission(change.mentionKey, added);
        expect(admitted.analysis.rejected).toEqual([]); expect(admitted.rejected).toEqual([]);
        expect(admitted.analysis.mentions[0].selection).toMatchObject({ start: added.start, end: added.end, quote: added.quote });
        expect(checkEntityReview(sample, admitted).criticalMentions.find(value => value.mentionKey === change.mentionKey)!.status).toBe('matched');
      }
      for (const rejected of decision.rejectedCandidates) {
        const admitted = admission(rejected.mentionKey, rejected);
        // Source validity alone never makes a semantically wrong widened span an exact gold match.
        expect(admitted.analysis.rejected).toEqual([]);
        expect(checkEntityReview(sample, admitted).criticalMentions.find(value => value.mentionKey === rejected.mentionKey)!.status).toBe('missing');
      }
    }
    const replay = JSON.parse(readFileSync(new URL('../../docs/public/entity-name-annotation-v12-replay.json', import.meta.url), 'utf8')) as {
      measurementId: string; frozen: { identity: { corpusDigest: string; guideDigest: string }; guides: { en: string; zh: string }; authorReview: unknown };
      historicalDigests: Record<string, string>; records: { sourceEvidence: string; sourceEvidenceDigest: string;
        caseId: string; inputDigest: string; outputDigest: string; originalOutput: string;
        originalOutcome: ReturnType<typeof reviewCapturedOutput>; replayedOutcome: ReturnType<typeof reviewCapturedOutput> }[];
    };
    expect(replay).toMatchObject({ purpose: 'offline_coverage_only_no_new_model_score', modelCallsExecuted: 0,
      newModelOutputs: 0, goldReady: false, originalScores: { v10: '10/13', v11: '2/3' }, recordedOutputsReplayed: 6 });
    expect(reviewDigest(JSON.stringify(replay.frozen.identity))).toBe(replay.measurementId);
    expect(replay.frozen.identity.corpusDigest).toBe(audit.corpusDigest);
    expect(reviewDigest(replay.frozen.guides.en + '\0' + replay.frozen.guides.zh)).toBe(replay.frozen.identity.guideDigest);
    for (const [path, hash] of Object.entries(replay.historicalDigests)) {
      expect(reviewDigest(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'))).toBe(hash);
    }
    expect(authorReviewStatus(JSON.stringify(replay.frozen.authorReview), corpus, replay.measurementId).status).toBe('completed');
    expect(replay.records).toHaveLength(6);
    for (const record of replay.records) {
      const raw = readFileSync(new URL(`../../docs/public/${record.sourceEvidence}`, import.meta.url), 'utf8');
      expect(reviewDigest(raw)).toBe(record.sourceEvidenceDigest);
      const source = JSON.parse(raw) as { captures: ReturnType<typeof reviewCapture>['capture'][]; records: typeof replay.records[number]['originalOutcome'][] };
      expect(source.captures.flatMap(value => value.records).find(value => value.caseId === record.caseId)!.result)
        .toMatchObject({ captureStatus: 'output', output: record.originalOutput });
      const sample = corpus.cases.find(value => value.caseId === record.caseId)!, input = entityReviewInput(sample);
      expect(reviewDigest(JSON.stringify(input))).toBe(record.inputDigest);
      expect(reviewDigest(record.originalOutput)).toBe(record.outputDigest);
      const checked = reviewCapturedOutput(sample, record.originalOutput, response => checkWindowExtractionResponse(response, input.excerpts));
      expect(JSON.parse(JSON.stringify(checked))).toEqual(record.replayedOutcome);
      expect(checked.checked).toEqual(record.originalOutcome.checked);
      expect(checked.checks!.semanticReview).toBe('pending');
    }
  });

  it('audits the stopped v11 boundary diagnostic without turning annotation gaps or unattempted cases into passes', () => {
    const evidence = JSON.parse(readFileSync(new URL('../../docs/public/entity-extraction-v11-boundary-diagnostic.json', import.meta.url), 'utf8')) as {
      conclusion: string; goldReady: boolean; annotationReview: string;
      manifest: { measurementId: string; corpusDigest: string; guideDigest: string; promptHash: string };
      frozen: { identity: Record<string, unknown>; corpusText: string; guides: { en: string; zh: string };
        prompt: { prompt: string }; authorReview: unknown; preparedPlanText: string };
      execution: { status: string; startedAt: string; maxCalls: number; attempted: number; recorded: number;
        executorInvocations: number; modelCallsExecuted: number; modelCalls: number; automaticRetries: number;
        preparedPlanDigest: string; originalManifestText: string; originalManifestDigest: string;
        unattemptedCaseIds: string[]; reviewed: { caseId: string; disposition: string; stopReason: string }[] };
      captures: ReturnType<typeof reviewCapture>['capture'][];
      records: (ReturnType<typeof reviewCapturedOutput> & { caseId: string; outputDigest: string })[];
      statistics: { matchedCriticalMentions: number; missingCriticalMentions: number };
      fullCorpusSplitSummaries: { split: string; notAttempted: number; uncheckedCriticalMentions: number }[];
      agentReview: { status: string; independentHumanReview: string; decisions: { caseId: string; outputDigest: string;
        disposition: string; stopReason: string; reviewedEntityIds: string[]; reviewedMentionIds: string[];
        reviewedProposals: { proposalId: string; statementIds: string[]; evidenceLinkIds: string[]; citationCount: number }[];
        roleReviews: { roleKey: string; coverage: string; status: string }[];
        boundaryFindings: { mentionKey: string; classification: string; strictStatus: string }[] }[] };
      baselineComparison: { sourceEvidenceDigest: string; originalScore: string; historicalScoreUnchanged: boolean; contemporaneousControlCalls: number };
    };
    const frozen = JSON.parse(evidence.frozen.corpusText) as typeof corpus;
    expect(reviewDigest(evidence.frozen.corpusText)).toBe(evidence.manifest.corpusDigest);
    expect(reviewDigest(evidence.frozen.guides.en + '\0' + evidence.frozen.guides.zh)).toBe(evidence.manifest.guideDigest);
    expect(reviewDigest(evidence.frozen.prompt.prompt)).toBe(evidence.manifest.promptHash);
    expect(reviewDigest(JSON.stringify(evidence.frozen.identity))).toBe(evidence.manifest.measurementId);
    expect(reviewDigest(evidence.frozen.preparedPlanText)).toBe(evidence.execution.preparedPlanDigest);
    expect(JSON.parse(evidence.frozen.preparedPlanText)).toMatchObject({ modelCallsExecuted: 0, maxCalls: 3 });
    expect(reviewDigest(evidence.execution.originalManifestText)).toBe(evidence.execution.originalManifestDigest);
    expect(JSON.parse(evidence.execution.originalManifestText)).toMatchObject({ modelCallsExecuted: 1, recorded: 1 });
    expect(evidence.execution).toMatchObject({ status: 'stopped_annotation_coverage_gap', maxCalls: 3,
      attempted: 1, recorded: 1, executorInvocations: 1, modelCallsExecuted: 1, modelCalls: 1, automaticRetries: 0,
      unattemptedCaseIds: ['held-config-literal-types', 'dev-keyboard-levels'] });
    const captures = evidence.captures.flatMap(capture => capture.records);
    expect(captures.map(value => value.caseId)).toEqual(['held-code-state-without-sha']);
    expect(evidence.records).toHaveLength(1); expect(evidence.agentReview.decisions).toHaveLength(1);
    const record = captures[0], selected = frozen.cases.find(value => value.caseId === record.caseId)!;
    expect(selected.split).toBe('development');
    const input = entityReviewInput(selected);
    expect(record.inputDigest).toBe(reviewDigest(JSON.stringify(input)));
    if (record.result.captureStatus !== 'output') throw new Error('Expected one preserved diagnostic output');
    const replayed = reviewCapturedOutput(selected, record.result.output,
      response => checkWindowExtractionResponse(response, input.excerpts));
    expect(evidence.records[0]).toMatchObject(JSON.parse(JSON.stringify(replayed)));
    expect(evidence.records[0].outputDigest).toBe(reviewDigest(record.result.output));
    expect(replayed.checks!.criticalMentions.map(value => [value.mentionKey, value.status])).toEqual([
      ['state-tested', 'matched'], ['state-unreleased', 'matched'], ['release', 'missing'],
    ]);
    expect(replayed.checks!.identityPairs.filter(value => value.status === 'not_evaluable')).toHaveLength(2);
    expect(replayed.checks!.semanticReview).toBe('pending');
    const raw = JSON.parse(record.result.output) as ReturnType<typeof packet>, decision = evidence.agentReview.decisions[0];
    expect(decision).toMatchObject({ caseId: record.caseId, outputDigest: evidence.records[0].outputDigest,
      disposition: 'stop', stopReason: 'annotation_coverage_gap',
      boundaryFindings: [{ mentionKey: 'release', classification: 'annotation_coverage_gap', strictStatus: 'missing' }] });
    expect(decision.reviewedEntityIds).toEqual(raw.entities.map(value => value.entityId));
    expect(decision.reviewedMentionIds).toEqual(raw.mentions.map(value => value.mentionId));
    expect(decision.reviewedProposals).toEqual(raw.proposals.map(value => ({ proposalId: value.proposalId,
      statementIds: value.draft.content.statements.map(statement => statement.statementId),
      evidenceLinkIds: value.draft.evidence.map(link => link.evidenceLinkId), citationCount: value.citations.length })));
    expect(decision.roleReviews.map(value => [value.roleKey, value.coverage])).toEqual(selected.roles.map(value => [value.roleKey, value.coverage]));
    expect(decision.roleReviews.filter(value => value.coverage === 'required')).toEqual([
      expect.objectContaining({ roleKey: 'current-result', status: 'observed_consistent_on_self_review' }),
    ]);
    expect(evidence.fullCorpusSplitSummaries).toEqual(evidence.captures.map(capture => ({ split: capture.split,
      ...reviewCapture(JSON.stringify(capture), frozen, evidence.manifest.measurementId, checkWindowExtractionResponse).summary })));
    expect(evidence.fullCorpusSplitSummaries.map(value => value.notAttempted)).toEqual([57, 2]);
    expect(evidence.fullCorpusSplitSummaries.reduce((n, value) => n + value.uncheckedCriticalMentions, 0)).toBe(196);
    expect(evidence.statistics).toMatchObject({ plannedWindows: 3, attemptedWindows: 1, unattemptedWindows: 2,
      plannedCriticalMentions: 9, checkedCriticalMentions: 3, uncheckedPlannedCriticalMentions: 6,
      matchedCriticalMentions: 2, missingCriticalMentions: 1, acceptedEntities: 3, acceptedMentions: 4,
      acceptedKnowledgeCandidates: 1, acceptedStatements: 3, unobservedPlannedRequiredKnowledgeRoles: 2,
      usdCost: 'unknown', reportedCostUSD: null });
    expect(authorReviewStatus(JSON.stringify(evidence.frozen.authorReview), frozen, evidence.manifest.measurementId, evidence.execution.startedAt).status).toBe('completed');
    expect(evidence.goldReady).toBe(false); expect(evidence.annotationReview).toBe('pending');
    expect(evidence.agentReview).toMatchObject({ status: 'completed', independentHumanReview: 'not_performed' });
    expect(evidence.baselineComparison).toMatchObject({ originalScore: '10/13', historicalScoreUnchanged: true, contemporaneousControlCalls: 0 });
    expect(reviewDigest(readFileSync(new URL('../../docs/public/entity-extraction-v10-diagnostic.json', import.meta.url), 'utf8')))
      .toBe(evidence.baselineComparison.sourceEvidenceDigest);
    expect(evidence.conclusion).toBe('target_main_boundary_observed_stopped_annotation_coverage_gap_full_quality_unverified');
  });

  it('audits v10 captures without rescoring longer boundaries or hiding incomplete splits', () => {
    const evidence = JSON.parse(readFileSync(new URL('../../docs/public/entity-extraction-v10-diagnostic.json', import.meta.url), 'utf8')) as {
      conclusion: string; goldReady: boolean; annotationReview: string;
      manifest: { measurementId: string; corpusDigest: string; guideDigest: string; promptHash: string; checkVersion: string };
      frozen: { identity: Record<string, unknown>; corpusText: string; guides: { en: string; zh: string };
        prompt: { prompt: string }; authorReview: unknown; preparedPlanText: string };
      execution: { startedAt: string; maxCalls: number; repeats: number; modelCalls: number; executorInvocations: number;
        selectedCaseIds: string[]; originalManifestText: string; originalManifestDigest: string; preparedPlanDigest: string };
      captures: ReturnType<typeof reviewCapture>['capture'][];
      records: (ReturnType<typeof reviewCapturedOutput> & { caseId: string; outputDigest: string })[];
      agentReview: { status: string; independentHumanReview: string; goldReady: boolean; decisions: {
        caseId: string; outputDigest: string; reviewedEntityIds: string[]; reviewedMentionIds: string[];
        reviewedProposals: { proposalId: string; statementIds: string[]; evidenceLinkIds: string[]; citationCount: number }[];
        roleReviews: { roleKey: string; coverage: string; statementIds: string[] }[]; boundaryFindings: unknown[] }[] };
      statistics: { matchedCriticalMentions: number; missingCriticalMentions: number; notEvaluableIdentityPairs: number };
      fullCorpusSplitSummaries: { split: string; notAttempted: number; uncheckedCriticalMentions: number }[];
      reproducibility: { captureDriverText: string; captureDriverDigest: string; inspectionDriverText: string; inspectionDriverDigest: string };
    };
    // Historical v10 metadata is deliberately rejected by the current reader; audit the immutable frozen shape.
    const frozen = JSON.parse(evidence.frozen.corpusText) as typeof corpus;
    expect(reviewDigest(evidence.frozen.corpusText)).toBe(evidence.manifest.corpusDigest);
    expect(reviewDigest(evidence.frozen.guides.en + '\0' + evidence.frozen.guides.zh)).toBe(evidence.manifest.guideDigest);
    expect(reviewDigest(evidence.frozen.prompt.prompt)).toBe(evidence.manifest.promptHash);
    expect(reviewDigest(JSON.stringify(evidence.frozen.identity))).toBe(evidence.manifest.measurementId);
    expect(reviewDigest(evidence.frozen.preparedPlanText)).toBe(evidence.execution.preparedPlanDigest);
    expect(reviewDigest(evidence.execution.originalManifestText)).toBe(evidence.execution.originalManifestDigest);
    expect(JSON.parse(evidence.execution.originalManifestText)).toMatchObject({ modelCalls: 0, executorInvocations: 5, recorded: 5 });
    expect(evidence.execution).toMatchObject({ maxCalls: 5, repeats: 1, modelCalls: 5, executorInvocations: 5 });
    expect(evidence.manifest.checkVersion).toBe(ENTITY_CHECK_VERSION);
    for (const prefix of ['capture', 'inspection'] as const) {
      expect(reviewDigest(evidence.reproducibility[`${prefix}DriverText`])).toBe(evidence.reproducibility[`${prefix}DriverDigest`]);
    }
    const captures = evidence.captures.flatMap(capture => capture.records);
    expect(captures).toHaveLength(5);
    expect(new Set(captures.map(record => record.caseId))).toEqual(new Set(evidence.execution.selectedCaseIds));
    expect(evidence.records).toHaveLength(5); expect(evidence.agentReview.decisions).toHaveLength(5);
    for (const record of captures) {
      const sample = frozen.cases.find(sample => sample.caseId === record.caseId)!;
      const input = entityReviewInput(sample);
      expect(record.inputDigest).toBe(reviewDigest(JSON.stringify(input)));
      if (record.result.captureStatus !== 'output') throw new Error('Expected five diagnostic outputs');
      const replayed = reviewCapturedOutput(sample, record.result.output, response => checkWindowExtractionResponse(response, input.excerpts));
      const published = evidence.records.find(outcome => outcome.caseId === record.caseId)!;
      expect(published).toMatchObject(JSON.parse(JSON.stringify(replayed)));
      expect(published.outputDigest).toBe(reviewDigest(record.result.output));
      const decisions = evidence.agentReview.decisions.filter(value => value.caseId === record.caseId);
      expect(decisions).toHaveLength(1);
      const decision = decisions[0]; const raw = JSON.parse(record.result.output) as ReturnType<typeof packet>;
      expect(decision.outputDigest).toBe(published.outputDigest);
      expect(decision.reviewedEntityIds).toEqual(raw.entities.map(entity => entity.entityId));
      expect(decision.reviewedMentionIds).toEqual(raw.mentions.map(mention => mention.mentionId));
      expect(decision.reviewedProposals).toEqual(raw.proposals.map(proposal => ({ proposalId: proposal.proposalId,
        statementIds: proposal.draft.content.statements.map(statement => statement.statementId),
        evidenceLinkIds: proposal.draft.evidence.map(link => link.evidenceLinkId), citationCount: proposal.citations.length })));
      expect(decision.roleReviews.map(role => [role.roleKey, role.coverage])).toEqual(sample.roles.map(role => [role.roleKey, role.coverage]));
      expect(decision.boundaryFindings).toHaveLength(replayed.checks!.criticalMentions.filter(mention => mention.status !== 'matched').length);
      expect(replayed.checks!.semanticReview).toBe('pending');
    }
    expect(evidence.statistics).toMatchObject({ matchedCriticalMentions: 10, missingCriticalMentions: 3, notEvaluableIdentityPairs: 4,
      acceptedEntities: 17, acceptedMentions: 22, acceptedKnowledgeCandidates: 5, acceptedStatements: 12 });
    expect(evidence.agentReview.decisions.find(decision => decision.caseId === 'held-code-state-without-sha')).toMatchObject({
      semanticStatus: 'knowledge_retention_consistent_code_state_mention_boundary_issue',
    });
    expect(evidence.fullCorpusSplitSummaries).toEqual(evidence.captures.map(capture => ({ split: capture.split,
      ...reviewCapture(JSON.stringify(capture), frozen, evidence.manifest.measurementId, checkWindowExtractionResponse).summary })));
    expect(evidence.fullCorpusSplitSummaries.map(value => value.notAttempted)).toEqual([53, 2]);
    expect(evidence.fullCorpusSplitSummaries.reduce((sum, value) => sum + value.uncheckedCriticalMentions, 0)).toBe(186);
    expect(authorReviewStatus(JSON.stringify(evidence.frozen.authorReview), frozen, evidence.manifest.measurementId, evidence.execution.startedAt).status).toBe('completed');
    expect(evidence.agentReview).toMatchObject({ status: 'completed', independentHumanReview: 'not_performed', goldReady: false });
    expect(evidence.goldReady).toBe(false); expect(evidence.annotationReview).toBe('pending');
    expect(evidence.conclusion).toBe('selected_semantics_observed_strict_boundary_regression_not_passed');
  });

  it('reuses recorded v10 outputs to distinguish complete names from owner-property phrases', () => {
    const evidence = JSON.parse(readFileSync(new URL('../../docs/public/entity-extraction-v10-diagnostic.json', import.meta.url), 'utf8')) as {
      frozen: { corpusText: string }; captures: ReturnType<typeof reviewCapture>['capture'][];
      statistics: { matchedCriticalMentions: number; missingCriticalMentions: number };
    };
    const before = JSON.stringify(evidence);
    const historical = JSON.parse(evidence.frozen.corpusText) as typeof corpus;
    for (const sample of v11.cases) {
      const old = historical.cases.find(value => value.caseId === sample.caseId)!;
      expect(entityReviewInput(sample)).toEqual(entityReviewInput(old));
      expect(sample.entities).toEqual(old.entities); expect(sample.roles).toEqual(old.roles);
      for (const mention of sample.mentions) {
        const original = old.mentions.find(value => value.mentionKey === mention.mentionKey)!;
        const extra = sample.caseId === 'held-code-state-without-sha' && mention.mentionKey === 'state-tested'
          ? [{ quote: '当前 main 的被测代码', occurrence: 0 }]
          : sample.caseId === 'held-config-literal-types' && mention.mentionKey === 'field'
            ? [{ quote: 'enabled 字段', occurrence: 0 }] : [];
        expect(mention.alternatives).toEqual([...original.alternatives, ...extra]);
      }
    }
    for (const captured of evidence.captures.flatMap(value => value.records)) {
      if (captured.result.captureStatus !== 'output') throw new Error('Expected recorded v10 output');
      const selected = v11.cases.find(sample => sample.caseId === captured.caseId)!;
      expect(selected.split).toBe('development');
      const input = entityReviewInput(selected);
      expect(captured.inputDigest).toBe(reviewDigest(JSON.stringify(input)));
      const checked = reviewCapturedOutput(selected, captured.result.output,
        response => checkWindowExtractionResponse(response, input.excerpts));
      expect(checked.structuralRejections).toEqual([]);
      expect(checked.checks!.semanticReview).toBe('pending');
      if (captured.caseId === 'held-code-state-without-sha') {
        expect(checked.checks!.criticalMentions.find(value => value.mentionKey === 'state-tested')!.status).toBe('matched');
        expect(checked.checks!.criticalMentions.find(value => value.mentionKey === 'state-unreleased')).toMatchObject({
          status: 'missing', boundaryCandidates: ['m4'],
        });
        const corrected = JSON.parse(captured.result.output) as ReturnType<typeof packet>;
        const oldOutput = structuredClone(corrected);
        const mention = corrected.mentions.find(value => value.mentionId === 'm4')!;
        // This authored correction exercises location/admission only, never a new model result or a rescore.
        mention.selection = { evidenceRef: `${selected.caseId}:0`, quote: 'main', occurrence: 1 };
        const correctedAdmission = checkWindowExtractionResponse(corrected, input.excerpts);
        expect(correctedAdmission.analysis.rejected).toEqual([]); expect(correctedAdmission.rejected).toEqual([]);
        expect(correctedAdmission.analysis.mentions.find(value => value.mentionId === 'm4')!.selection).toEqual({
          evidenceRef: `${selected.caseId}:0`, quote: 'main', start: 34, end: 38,
        });
        const correction = checkEntityReview(selected, correctedAdmission);
        expect(correction.criticalMentions.every(value => value.status === 'matched')).toBe(true);
        expect(correction.identityPairs.every(value => value.status === 'matched')).toBe(true);
        expect(corrected.proposals).toEqual(oldOutput.proposals); expect(corrected.entities).toEqual(oldOutput.entities);
        for (const quote of ['main 上的改造', input.excerpts[0].text]) {
          mention.selection = { evidenceRef: `${selected.caseId}:0`, quote };
          expect(checkEntityReview(selected, checkWindowExtractionResponse(corrected, input.excerpts))
            .criticalMentions.find(value => value.mentionKey === 'state-unreleased')!.status).toBe('missing');
        }
      } else {
        expect(checked.checks!.criticalMentions.every(value => value.status === 'matched')).toBe(true);
      }
    }
    expect(JSON.stringify(evidence)).toBe(before);
    expect(evidence.statistics).toMatchObject({ matchedCriticalMentions: 10, missingCriticalMentions: 3 });
  });

  it.each([
    { version: 'v6', windows: 36, calls: 11, critical: 40, matched: 39, missing: 1, notEvaluable: 3, unattempted: 25, conclusion: 'selected_strict_regression_not_passed' },
    { version: 'v7', windows: 42, calls: 6, critical: 22, matched: 20, missing: 2, notEvaluable: 11, unattempted: 36, conclusion: 'targeted_behaviors_observed_strict_regression_not_passed' },
    { version: 'v8', windows: 48, calls: 5, critical: 21, matched: 21, missing: 0, notEvaluable: 0, unattempted: 43, conclusion: 'selected_granularity_behaviors_observed_full_quality_unverified' },
  ])('replays $version diagnostic without hiding unattempted windows, misses or missing independent evidence', expected => {
    type Capture = ReturnType<typeof reviewCapture>['capture'];
    type Outcome = ReturnType<typeof reviewCapturedOutput>;
    const evidence = JSON.parse(readFileSync(new URL(`../../docs/public/entity-extraction-${expected.version}-diagnostic.json`, import.meta.url), 'utf8')) as {
      conclusion: string; goldReady: boolean; annotationReview: string;
      manifest: { measurementId: string; corpusDigest: string; guideDigest: string; promptHash: string; checkVersion: string };
      frozen: { corpusText: string; guides: { en: string; zh: string }; prompt: { prompt: string }; preparedPlanText?: string; identity: Record<string, unknown>; authorReview?: unknown };
      execution: { selectedCaseIds: string[]; repeats: number; maxCalls: number; attempted: number; recorded: number; status?: string; executorInvocations?: number; startedAt?: string; preparedPlanDigest?: string };
      captureCompletion?: { status: string; planned: number; recorded: number; executorInvocations: number; originalDriverStatus: string; driverExitCode: number; localDriverIssue: string };
      captures: Capture[]; records: (Outcome & { caseId: string; outputDigest: string; checked?: ReturnType<typeof checkWindowExtractionResponse> })[];
      agentReview: { status: string; independentHumanReview: string; decisions: { caseId: string; outputDigest: string; rationale: string; reviewedEntityIds?: string[]; reviewedMentionIds?: string[]; reviewedProposals?: { proposalId: string; statementIds: string[]; evidenceLinkIds: string[] }[] }[] };
      statistics: { plannedCriticalMentions: number; matchedCriticalMentions: number; missingCriticalMentions: number; notEvaluableIdentityPairs: number; wrongMerges: number; wrongSplits: number; identityMismatches: number; structuralRejectingOutputs: number; usdCost: string; reportedCostUSD: null };
      fullCorpusSplitSummaries: { split: string; notAttempted: number; captureStatus: string }[];
      reproducibility: { captureDriverText: string; captureDriverDigest: string };
    };
    expect(evidence.manifest.checkVersion).toBe('omk-entity-critical-checks/v3');
    expect(reviewDigest(evidence.frozen.corpusText)).toBe(evidence.manifest.corpusDigest);
    expect(reviewDigest(evidence.frozen.guides.en + '\0' + evidence.frozen.guides.zh)).toBe(evidence.manifest.guideDigest);
    expect(reviewDigest(evidence.frozen.prompt.prompt)).toBe(evidence.manifest.promptHash);
    expect(reviewDigest(JSON.stringify(evidence.frozen.identity))).toBe(evidence.manifest.measurementId);
    expect(reviewDigest(evidence.reproducibility.captureDriverText)).toBe(evidence.reproducibility.captureDriverDigest);
    const frozen = JSON.parse(evidence.frozen.corpusText) as { cases: EntityReviewCase[] };
    expect(frozen.cases).toHaveLength(expected.windows);
    const captured = evidence.captures.flatMap(capture => capture.records);
    expect(captured).toHaveLength(expected.calls);
    expect(evidence.execution).toMatchObject({ repeats: 1, maxCalls: expected.calls, attempted: expected.calls, recorded: expected.calls });
    expect(new Set(captured.map(record => record.caseId))).toEqual(new Set(evidence.execution.selectedCaseIds));
    for (const record of captured) {
      const sample = frozen.cases.find(sample => sample.caseId === record.caseId)!;
      const input = entityReviewInput(sample);
      expect(record.inputDigest).toBe(reviewDigest(JSON.stringify(input)));
      if (record.result.captureStatus !== 'output') throw new Error('Expected diagnostic output');
      const inspected = { ...sample, roles: sample.roles.map(role => ({ ...role, coverage: 'if_selected' as const })) };
      const replayed = reviewCapturedOutput(inspected, record.result.output,
        response => checkWindowExtractionResponse(response, input.excerpts));
      const published = evidence.records.find(outcome => outcome.caseId === record.caseId)!;
      expect(published.outputDigest).toBe(reviewDigest(record.result.output));
      // Inspect stable structural projections only; current coverage obligations never re-score frozen v3 evidence.
      const stableChecks = { ...replayed.checks! };
      Reflect.deleteProperty(stableChecks, 'knowledgeCoverage');
      expect({ captureStatus: published.captureStatus, structuralRejections: published.structuralRejections, checks: published.checks })
        .toEqual(JSON.parse(JSON.stringify({ captureStatus: replayed.captureStatus, structuralRejections: replayed.structuralRejections,
          checks: { ...stableChecks, checkVersion: evidence.manifest.checkVersion } })));
      const decision = evidence.agentReview.decisions.filter(value => value.caseId === record.caseId);
      expect(decision).toHaveLength(1); expect(decision[0].outputDigest).toBe(published.outputDigest);
      expect(decision[0].rationale.length).toBeGreaterThan(20);
      if (expected.version === 'v8') {
        const raw = JSON.parse(record.result.output) as ReturnType<typeof packet>;
        expect(published.checked).toEqual(JSON.parse(JSON.stringify(checkWindowExtractionResponse(raw, input.excerpts))));
        expect(decision[0].reviewedEntityIds).toEqual(raw.entities.map(value => value.entityId));
        expect(decision[0].reviewedMentionIds).toEqual(raw.mentions.map(value => value.mentionId));
        expect(decision[0].reviewedProposals).toEqual(raw.proposals.map(value => ({ proposalId: value.proposalId,
          statementIds: value.draft.content.statements.map(statement => statement.statementId),
          evidenceLinkIds: value.draft.evidence.map(link => link.evidenceLinkId) })));
      }
    }
    expect(evidence.records).toHaveLength(expected.calls); expect(evidence.agentReview.decisions).toHaveLength(expected.calls);
    const sum = (count: (record: typeof evidence.records[number]) => number) => evidence.records.reduce((n, record) => n + count(record), 0);
    expect(evidence.statistics).toMatchObject({ plannedCriticalMentions: expected.critical, matchedCriticalMentions: expected.matched,
      missingCriticalMentions: expected.missing, notEvaluableIdentityPairs: expected.notEvaluable, usdCost: 'unknown', reportedCostUSD: null });
    expect(sum(record => record.checks!.criticalMentions.filter(value => value.status === 'matched').length)).toBe(expected.matched);
    expect(sum(record => record.checks!.criticalMentions.filter(value => value.status !== 'matched').length)).toBe(evidence.statistics.missingCriticalMentions);
    expect(sum(record => record.checks!.identityPairs.filter(value => value.status === 'not_evaluable').length)).toBe(evidence.statistics.notEvaluableIdentityPairs);
    expect(sum(record => record.checks!.identityPairs.filter(value => value.status === 'wrong_merge').length)).toBe(evidence.statistics.wrongMerges);
    expect(sum(record => record.checks!.identityPairs.filter(value => value.status === 'wrong_split').length)).toBe(evidence.statistics.wrongSplits);
    expect(sum(record => record.checks!.identities.filter(value => value.status === 'mismatched').length)).toBe(evidence.statistics.identityMismatches);
    expect(evidence.records.filter(record => record.structuralRejections.length).length).toBe(evidence.statistics.structuralRejectingOutputs);
    expect(evidence.fullCorpusSplitSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ split: 'development', notAttempted: expected.unattempted, captureStatus: 'incomplete' }),
      expect.objectContaining({ split: 'validation', notAttempted: 0, captureStatus: 'captured' }),
    ]));
    expect(evidence.conclusion).toBe(expected.conclusion);
    expect(evidence.goldReady).toBe(false); expect(evidence.annotationReview).toBe('pending');
    expect(evidence.agentReview).toMatchObject({ status: 'completed', independentHumanReview: 'not_performed' });
    if (expected.version === 'v8') {
      expect(evidence.execution).toMatchObject({ status: 'captured', executorInvocations: 5 });
      expect(reviewDigest(evidence.frozen.preparedPlanText!)).toBe(evidence.execution.preparedPlanDigest);
      expect(evidence.reproducibility.captureDriverText).toContain('state.recorded === plan.caseCount');
      expect(evidence.statistics).toMatchObject({ acceptedEntities: 13, acceptedMentions: 23, acceptedKnowledgeCandidates: 6, acceptedStatements: 16 });
      expect(sum(record => record.checked!.analysis.entities.length)).toBe(13);
      expect(sum(record => record.checked!.analysis.mentions.length)).toBe(23);
      expect(sum(record => record.checked!.accepted.length)).toBe(6);
      expect(sum(record => record.checked!.accepted.reduce((n, value) => n + value.draft.content.statements.length, 0))).toBe(16);
      // Historical digests and checker v3 are audited above; the current reader deliberately rejects v8.
      const historicalCorpus = JSON.parse(evidence.frozen.corpusText) as typeof corpus;
      historicalCorpus.cases.forEach(sample => sample.roles.forEach(role => { role.coverage = 'if_selected'; }));
      expect(evidence.fullCorpusSplitSummaries).toEqual(evidence.captures.map(capture => {
        const replay = reviewCapture(JSON.stringify(capture), historicalCorpus, evidence.manifest.measurementId, checkWindowExtractionResponse);
        return { split: capture.split, ...replay.summary };
      }));
      expect(authorReviewStatus(JSON.stringify(evidence.frozen.authorReview), historicalCorpus, evidence.manifest.measurementId, evidence.execution.startedAt).status).toBe('completed');
    }
    if (expected.version === 'v7') {
      expect(evidence.execution).toMatchObject({ status: 'incomplete', executorInvocations: 6 });
      expect(evidence.captureCompletion).toMatchObject({ status: 'captured', planned: 6, recorded: 6, executorInvocations: 6, originalDriverStatus: 'incomplete', driverExitCode: 1 });
      expect(evidence.captureCompletion!.localDriverIssue).toContain('state.recorded === 11');
      expect(evidence.reproducibility.captureDriverText).toContain('state.recorded === 11');
      // Audit the receipt against its immutable historical corpus, not the current corpus reader.
      expect(authorReviewStatus(JSON.stringify(evidence.frozen.authorReview), JSON.parse(evidence.frozen.corpusText) as typeof corpus, evidence.manifest.measurementId, evidence.execution.startedAt).status).toBe('completed');
    }
  });

  it('audits the immutable published v4 two-round evidence without converting self-review or missing cost into a pass', () => {
    type Captured = ReturnType<typeof reviewCapture>['capture'];
    type Checked = ReturnType<typeof reviewCapture>['records'][number];
    const evidence = JSON.parse(readFileSync(new URL('../../docs/public/entity-extraction-v4-repeat-quality.json', import.meta.url), 'utf8')) as {
      conclusion: string; goldReady: boolean; annotationReview: string;
      manifest: { measurementId: string; corpusDigest: string; guideDigest: string; promptHash: string };
      frozen: { corpusText: string; guides: { en: string; zh: string }; prompt: { prompt: string }; identity: Record<string, unknown> };
      captures: Captured[]; records: (Checked & { outputDigest: string; executorReported: { inputTokens: number; cacheReadTokens: number; outputTokens: number; costReportedByExecutor: boolean } })[];
      agentReview: { status: string; independentHumanReview: string; decisions: { caseId: string; repeat: number; outputDigest: string; rationale: string; issues: unknown[] }[] };
      statistics: { total: { recorded: number; matchedCriticalMentions: number; notEvaluableIdentityPairs: number; identityMismatches: number; reportedUncachedInputTokens: number; reportedCacheReadTokens: number; reportedOutputTokens: number; costReportingRecords: number; reportedCostUSD: null; usdCost: string } };
    };
    expect(evidence.frozen.corpusText).toBe(readFileSync(new URL('../fixtures/entity-extraction-review-v4.json', import.meta.url), 'utf8'));
    expect(reviewDigest(evidence.frozen.corpusText)).toBe('sha256:ad31afbbb1db44bc98dc2e8e6f545419f39317e5d83f745382c445d715cf4b67');
    expect(reviewDigest(evidence.frozen.corpusText)).toBe(evidence.manifest.corpusDigest);
    expect(reviewDigest(evidence.frozen.guides.en + '\0' + evidence.frozen.guides.zh)).toBe(evidence.manifest.guideDigest);
    expect(reviewDigest(evidence.frozen.prompt.prompt)).toBe(evidence.manifest.promptHash);
    expect(reviewDigest(JSON.stringify(evidence.frozen.identity))).toBe(evidence.manifest.measurementId);
    expect(evidence.captures.map(value => value.split).sort()).toEqual(['development', 'validation']);
    // Historical checks are frozen evidence, never recalculated with the current checker or annotations.
    expect(evidence.captures.every(capture => capture.repeats === 2)).toBe(true);
    const capturedRecords = evidence.captures.flatMap(capture => capture.records);
    expect(capturedRecords).toHaveLength(32);
    const keys = new Set<string>();
    for (const outcome of evidence.records) {
      const key = `${outcome.repeat}:${outcome.caseId}`;
      expect(keys.has(key)).toBe(false); keys.add(key);
      const published = evidence.records.find(value => value.repeat === outcome.repeat && value.caseId === outcome.caseId)!;
      if (outcome.captureStatus !== 'captured' || published.captureStatus !== 'captured') throw new Error('Expected captured output');
      expect(published.checks!.checkVersion).toBe('omk-entity-critical-checks/v2');
      const captured = evidence.captures.flatMap(value => value.records).find(value => value.repeat === outcome.repeat && value.caseId === outcome.caseId)!;
      expect(captured.result.captureStatus).toBe('output');
      if (captured.result.captureStatus !== 'output') throw new Error('Expected actual model output');
      expect(published.outputDigest).toBe(reviewDigest(captured.result.output));
      const decisions = evidence.agentReview.decisions.filter(value => value.caseId === outcome.caseId && value.repeat === outcome.repeat);
      expect(decisions).toHaveLength(1); expect(decisions[0].outputDigest).toBe(published.outputDigest);
      expect(decisions[0].rationale.length).toBeGreaterThan(20);
    }
    expect(evidence.records).toHaveLength(32); expect(evidence.agentReview.decisions).toHaveLength(32);
    expect(evidence.agentReview.decisions.filter(value => value.issues.length)).toHaveLength(7);
    const sum = (read: (record: typeof evidence.records[number]) => number) => evidence.records.reduce((n, record) => n + read(record), 0);
    expect(evidence.statistics.total).toMatchObject({ recorded: 32,
      matchedCriticalMentions: sum(record => record.checks!.criticalMentions.filter(value => value.status === 'matched').length),
      notEvaluableIdentityPairs: sum(record => record.checks!.identityPairs.filter(value => value.status === 'not_evaluable').length),
      identityMismatches: sum(record => record.checks!.identities.filter(value => value.status === 'mismatched').length),
      reportedUncachedInputTokens: sum(record => record.executorReported.inputTokens),
      reportedCacheReadTokens: sum(record => record.executorReported.cacheReadTokens),
      reportedOutputTokens: sum(record => record.executorReported.outputTokens),
      costReportingRecords: 0, reportedCostUSD: null, usdCost: 'unknown' });
    expect(evidence.records.every(value => value.executorReported.costReportedByExecutor === false)).toBe(true);
    expect(evidence.conclusion).toBe('frozen_regression_not_passed'); expect(evidence.goldReady).toBe(false);
    expect(evidence.annotationReview).toBe('pending');
    expect(evidence.agentReview).toMatchObject({ status: 'completed', independentHumanReview: 'not_performed' });
  });

  it('validates the synthetic draft and prevents group/window leakage and contradictory annotations', () => {
    expect(corpus.cases.filter(value => value.split === 'development')).toHaveLength(58);
    expect(corpus.cases.filter(value => value.split === 'validation')).toHaveLength(2);
    expect(corpus.cases.reduce((count, value) => count + value.mentions.length, 0)).toBe(199);
    for (const mutate of [
      (copy: typeof corpus) => { copy.cases[52].projectGroup = copy.cases[0].projectGroup; },
      (copy: typeof corpus) => { copy.cases[52].conversationGroup = copy.cases[0].conversationGroup; },
      (copy: typeof corpus) => { copy.cases[52].messages = copy.cases[0].messages; },
      (copy: typeof corpus) => { copy.cases[0].mentions[0].alternatives[0].occurrence = 99; },
      (copy: typeof corpus) => { copy.cases[0].entities[0].component = 'file'; },
      (copy: typeof corpus) => { copy.cases[3].entities[2].collection!.members.push('pair'); },
    ]) {
      const copy = structuredClone(corpus); mutate(copy);
      expect(() => parseEntityReviewCorpus(JSON.stringify(copy))).toThrow();
    }
    const repeated = corpus.cases.find(value => value.caseId === 'dev-repeated-code')!;
    expect(reviewMentions(repeated).map(value => value.spans[0].start)).toEqual([4, 18, 29]);
    const input = entityReviewInput(repeated);
    expect(Object.keys(input)).toEqual(['excerpts', 'limitations']);
    expect(input.excerpts[0].text).toBe(repeated.messages[0].text);
    for (const field of ['referentKinds', 'semanticChecks', 'projectGroup', 'split', 'alternatives', 'coverage', 'interpretation']) expect(JSON.stringify(input)).not.toContain(field);
    const historical = readFileSync(new URL('../fixtures/entity-extraction-review.json', import.meta.url), 'utf8');
    expect(reviewDigest(historical)).toBe('sha256:a9752138e4365b050b2b54c1a49d26f59cdcdd5958738d32950a10b7f56ce6ff');
    expect(() => parseEntityReviewCorpus(historical)).toThrow();
    const prior = readFileSync(new URL('../fixtures/entity-extraction-review-v4.json', import.meta.url), 'utf8');
    expect(reviewDigest(prior)).toBe('sha256:ad31afbbb1db44bc98dc2e8e6f545419f39317e5d83f745382c445d715cf4b67');
    expect(() => parseEntityReviewCorpus(prior)).toThrow();
    const v5 = readFileSync(new URL('../fixtures/entity-extraction-review-v5.json', import.meta.url), 'utf8');
    expect(reviewDigest(v5)).toBe('sha256:df117b4b56060a845fda00f4d57b91de71c24f3e33d6962d77d314782b971ca1');
    expect(() => parseEntityReviewCorpus(v5)).toThrow();
    const v6 = readFileSync(new URL('../fixtures/entity-extraction-review-v6.json', import.meta.url), 'utf8');
    expect(reviewDigest(v6)).toBe('sha256:e19f086900284a36f714b27239003e0d0720984e3a6f6cea93a779f64b883338');
    expect(() => parseEntityReviewCorpus(v6)).toThrow();
    const v7 = readFileSync(new URL('../fixtures/entity-extraction-review-v7.json', import.meta.url), 'utf8');
    expect(reviewDigest(v7)).toBe('sha256:f8abb08120091d4abf9d88a47086b8e3ba921c9bdcf3ee3249ae935eb6a3ef0a');
    expect(() => parseEntityReviewCorpus(v7)).toThrow();
    const v8 = readFileSync(new URL('../fixtures/entity-extraction-review-v8.json', import.meta.url), 'utf8');
    expect(reviewDigest(v8)).toBe('sha256:86171b6ed03edf8bc71a0cfce7a66ac982ef610055927092ea151dddee9c9587');
    expect(() => parseEntityReviewCorpus(v8)).toThrow();
    const v9 = readFileSync(new URL('../fixtures/entity-extraction-review-v9.json', import.meta.url), 'utf8');
    expect(reviewDigest(v9)).toBe('sha256:703a98fb468a0394e6ff6de40e2bc1724ef193530914132217e163a7c61996c7');
    expect(() => parseEntityReviewCorpus(v9)).toThrow();
    expect(v11.cases.slice(0, 54)).toEqual((JSON.parse(v9) as typeof corpus).cases
      .map(value => ({ ...value, roles: value.roles.map(role => ({ ...role, coverage: 'if_selected' })) })));
    // No v9 model outputs have been viewed; its two reserved windows remain validation.
    expect(corpus.cases.slice(0, 54).filter(value => value.split === 'validation')).toHaveLength(2);
    const v10 = readFileSync(new URL('../fixtures/entity-extraction-review-v10.json', import.meta.url), 'utf8');
    expect(reviewDigest(v10)).toBe('sha256:40819fc1698b76b8921ab6d39bd57a6027b5d12460e2ce61d4d802f587443473');
    expect(() => parseEntityReviewCorpus(v10)).toThrow();
    expect(corpus.cases.filter(value => value.split === 'validation').map(value => value.caseId)).toEqual(
      (JSON.parse(v10) as typeof corpus).cases.filter(value => value.split === 'validation' && !['held-code-state-without-sha', 'held-config-literal-types'].includes(value.caseId)).map(value => value.caseId));
    const rule = corpus.cases.find(value => value.caseId === 'fresh-negative-requirement')!;
    expect(rule.mentions.find(value => value.mentionKey === 'rule-first')!.alternatives).toEqual([
      { quote: 'F9', occurrence: 0 }, { quote: 'Rule F9', occurrence: 0 },
    ]);
    const replaced = reviewMentions(corpus.cases.find(value => value.caseId === 'dev-replacement')!);
    expect(replaced.slice(0, 2).map(value => value.spans[0].quote)).toEqual(['config.json', 'config.json']);
    expect(replaced[0].entity).not.toBe(replaced[1].entity);
    expect(replaced[0].spans[0].start).not.toBe(replaced[1].spans[0].start);
  });

  it.each(['dev-property-values', 'held-unnamed-metric-concepts'])('checks the prefrozen %s identity boundary without demanding property entities or collapsing independent concepts', caseId => {
    const sample = corpus.cases.find(value => value.caseId === caseId)!;
    const output = modelWindow();
    output.proposals = [];
    output.entities = sample.entities.map(entity => ({ ...output.entities[0], entityId: entity.entityKey,
      label: entity.entityKey, description: entity.rationale }));
    output.mentions = sample.mentions.map(mention => ({ mentionId: mention.mentionKey, entityId: mention.entity,
      basis: 'explicit', rationale: mention.rationale,
      selection: { evidenceRef: `${sample.caseId}:${mention.messageIndex}`, ...mention.alternatives[0] } }));
    const admit = () => checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
    expect(admit().analysis.rejected).toEqual([]);
    const checked = checkEntityReview(sample, admit());
    expect(checked.criticalMentionRecall).toEqual({ matched: sample.mentions.length, total: sample.mentions.length, value: 1 });
    expect(checked.identityPairs.every(pair => pair.status === 'matched')).toBe(true);
    // This exercises the offline checker with a fabricated response, not model capability or knowledge coverage.
    if (caseId === 'held-unnamed-metric-concepts') {
      output.entities = output.entities.slice(0, 1);
      output.mentions.forEach(mention => { mention.entityId = output.entities[0].entityId; });
      expect(checkEntityReview(sample, admit()).identityPairs.some(pair => pair.status === 'wrong_merge')).toBe(true);
    }
  });

  it('requires exact allowed boundaries and separates false merges, false splits and missing mentions', () => {
    const output = packet(); output.proposals = [];
    const good = checkEntityReview(sample, check(output));
    expect(good.criticalMentionRecall).toEqual({ matched: 2, total: 2, value: 1 });
    expect(good.precision).toBeNull(); expect(good.f1).toBeNull();
    output.mentions[0].selection.quote = 'Alpha drives';
    const broad = checkEntityReview(sample, check(output));
    expect(broad.criticalMentions[0]).toMatchObject({ status: 'missing', boundaryCandidates: ['m1'] });
    expect(broad.identityPairs[0].status).toBe('not_evaluable');
    output.mentions[0].selection.quote = 'Alpha'; output.entities = output.entities.slice(0, 1); output.mentions[1].entityId = 'project';
    expect(checkEntityReview(sample, check(output)).identityPairs[0].status).toBe('wrong_merge');
    const alias = structuredClone(sample); alias.messages[0].text = 'Alpha Alpha'; alias.entities = [alias.entities[0]];
    alias.mentions[1] = { ...alias.mentions[0], mentionKey: 'alias', alternatives: [{ quote: 'Alpha', occurrence: 1 }] }; alias.roles = [];
    const split = packet(); split.proposals = []; split.mentions[0].selection.occurrence = 0;
    split.mentions[1].selection = { evidenceRef: 'roles:0', quote: 'Alpha', occurrence: 1 };
    expect(checkEntityReview(alias, checkWindowExtractionResponse(split, entityReviewInput(alias).excerpts)).identityPairs[0].status).toBe('wrong_split');
  });

  it('keeps required knowledge separate from entity coverage, optional absence and semantic completeness', () => {
    const selected = corpus.cases.find(value => value.caseId === 'dev-config-rationale')!;
    const output = modelWindow();
    const base = output.proposals[0];
    output.entities = selected.entities.map(entity => ({ ...output.entities[0], entityId: entity.entityKey,
      label: entity.entityKey, description: entity.rationale }));
    output.mentions = selected.mentions.map(mention => ({ ...output.mentions[0], mentionId: mention.mentionKey,
      entityId: mention.entity, selection: { evidenceRef: `${selected.caseId}:0`, ...mention.alternatives[0] } }));
    base.entityIds = output.entities.map(entity => entity.entityId);
    base.mentionIds = output.mentions.map(mention => mention.mentionId);
    base.draft.content.statements = [{ ...base.draft.content.statements[0], subject: { entityId: 'field' },
      object: undefined, relation: '配置合理' }];
    base.draft.evidence[0].evidenceRef = `${selected.caseId}:0`;
    base.draft.evidence[0].basis = 'source_assertion';
    base.citations[0].selection = { evidenceRef: `${selected.caseId}:0`, quote: selected.messages[0].text };
    const review = () => checkEntityReview(selected, checkWindowExtractionResponse(output, entityReviewInput(selected).excerpts));
    expect(review().checkVersion).toBe(ENTITY_CHECK_VERSION);
    expect(ENTITY_CHECK_VERSION).toBe('omk-entity-critical-checks/v4');
    expect(review().criticalMentionRecall.value).toBe(1);
    expect(review().roles[0]).toMatchObject({ endpointStatus: 'endpoints_matched', semanticReview: 'pending' });
    // An endpoint match with a lossy sentence still requires semantic review; there is no literal-keyword pass.
    expect(review().knowledgeCoverage[0]).toMatchObject({ coverage: 'required', status: 'needs_review', semanticReview: 'pending',
      interpretation: selected.roles[0].interpretation, candidates: [{ proposalId: base.proposalId, statementId: 'usage' }] });
    base.draft.content.statements[0].subject.entityId = 'client';
    expect(review().knowledgeCoverage[0].status).toBe('needs_review');
    // An existing owner subject is reviewable even when the field-subject endpoint projection differs.
    expect(review().knowledgeCoverage[0].candidates).toHaveLength(1);
    base.entityIds = ['absent'];
    expect(review().knowledgeCoverage[0].status).toBe('not_evaluable');
    output.proposals = [];
    expect(review().criticalMentionRecall.value).toBe(1);
    expect(review().knowledgeCoverage[0]).toMatchObject({ status: 'required_not_observed', candidates: [], semanticReview: 'pending' });
    const optional = { ...selected, roles: selected.roles.map(role => ({ ...role, coverage: 'if_selected' as const })) };
    expect(checkEntityReview(optional, checkWindowExtractionResponse(output, entityReviewInput(optional).excerpts))
      .knowledgeCoverage[0].status).toBe('not_observed');
    const conflicting = structuredClone(corpus);
    conflicting.cases.find(value => value.caseId === selected.caseId)!.knowledgePolicy = 'none';
    expect(() => parseEntityReviewCorpus(JSON.stringify(conflicting))).toThrow('Required knowledge contradicts none policy');
    const unmarked = structuredClone(corpus);
    Reflect.deleteProperty(unmarked.cases.find(value => value.caseId === selected.caseId)!.roles[0], 'coverage');
    expect(() => parseEntityReviewCorpus(JSON.stringify(unmarked))).toThrow();
    expect(entityReviewHtml(corpus, measurementId)).toContain('coverage 为 required');
  });

  it('allows prefrozen tested-state levels while keeping distinct commits apart and unknown SHAs out of resolution', () => {
    for (const caseId of ['dev-branch-commits', 'held-code-state-without-sha']) {
      const selected = corpus.cases.find(value => value.caseId === caseId)!;
      const output = modelWindow(); output.proposals = [];
      output.entities = selected.entities.map(entity => ({ ...output.entities[0], entityId: entity.entityKey,
        label: entity.entityKey, description: entity.rationale, referentKind: entity.referentKinds[0] }));
      output.mentions = selected.mentions.map(mention => ({ ...output.mentions[0], mentionId: mention.mentionKey,
        entityId: mention.entity, selection: { evidenceRef: `${selected.caseId}:0`, ...mention.alternatives[0] } }));
      const review = () => checkEntityReview(selected, checkWindowExtractionResponse(output, entityReviewInput(selected).excerpts));
      expect(review().identities.every(identity => identity.status === 'matched')).toBe(true);
      if (caseId === 'held-code-state-without-sha') {
        output.entities[0].referentKind = 'version';
        expect(review().identities.every(identity => identity.status === 'matched')).toBe(true);
        output.entities[0].identityStatus = 'unresolved'; output.entities[0].uncertainties = ['未提供 SHA'];
        expect(review().identities[0].problems).toContain('identity_status');
      } else {
        output.mentions[3].entityId = 'a1';
        expect(review().identityPairs.some(pair => pair.status === 'wrong_merge')).toBe(true);
      }
    }
  });

  it('detects omitted concepts and premature disambiguation in v8 without rejecting valid nested spans or explicit clarification', () => {
    for (const caseId of ['dev-session-properties', 'dev-unconfirmed-memory', 'dev-confirmed-memory']) {
      const sample = corpus.cases.find(value => value.caseId === caseId)!;
      const output = modelWindow(); output.proposals = [];
      output.entities = sample.entities.map(value => ({ ...output.entities[0], entityId: value.entityKey,
        label: value.entityKey, description: value.rationale, identityStatus: value.identityStatus,
        possibleEntityIds: value.possibleEntities, uncertainties: value.identityStatus === 'unresolved' ? [value.rationale] : [] }));
      output.mentions = sample.mentions.map(value => ({ ...output.mentions[0], mentionId: value.mentionKey, entityId: value.entity,
        selection: { evidenceRef: `${caseId}:${value.messageIndex}`, ...value.alternatives[0] } }));
      const excerpts = entityReviewInput(sample).excerpts;
      const admitted = checkWindowExtractionResponse(output, excerpts);
      expect(admitted.analysis.rejected).toEqual([]);
      const good = checkEntityReview(sample, admitted);
      expect(good.criticalMentions.every(value => value.status === 'matched')).toBe(true);
      expect(good.identities.every(value => value.status === 'matched')).toBe(true);
      if (caseId === 'dev-session-properties') {
        output.entities = output.entities.filter(entity => entity.entityId !== 'session');
        output.mentions = output.mentions.filter(mention => mention.entityId !== 'session');
        const missing = checkEntityReview(sample, checkWindowExtractionResponse(output, excerpts));
        expect(missing.criticalMentions.filter(value => value.status === 'missing')).toHaveLength(4);
        expect(missing.criticalMentions.filter(value => value.status === 'matched').map(value => value.mentionKey)).toEqual(['adaptation']);
      } else if (caseId === 'dev-unconfirmed-memory') {
        output.entities = output.entities.filter(entity => entity.entityId !== 'unknown');
        output.mentions[0].entityId = 'atlas';
        output.mentions[0].rationale = 'Assistant chose Atlas, but user did not confirm.';
        const guessed = checkEntityReview(sample, checkWindowExtractionResponse(output, excerpts));
        expect(guessed.criticalMentions.every(value => value.status === 'matched')).toBe(true);
        expect(guessed.identityPairs.some(value => value.status === 'wrong_merge')).toBe(true);
        expect(guessed.identities.find(value => value.entity === 'unknown')!.problems).toContain('identity_status');
      }
    }
  });

  it('keeps polarity review separate from structural admission for the atomic-statement regression', () => {
    const sample = corpus.cases.find(value => value.caseId === 'dev-session-atomic-negation')!;
    const output = modelWindow();
    output.entities = [{ ...output.entities[0], entityId: 'session', label: 'Session', description: sample.entities[0].rationale }];
    output.mentions = sample.mentions.map(value => ({ ...output.mentions[0], mentionId: value.mentionKey, entityId: 'session',
      selection: { evidenceRef: `${sample.caseId}:0`, ...value.alternatives[0] } }));
    const proposal = output.proposals[0];
    proposal.entityIds = ['session']; proposal.mentionIds = output.mentions.map(value => value.mentionId);
    const base = proposal.draft.content.statements[0];
    proposal.draft.content.statements = [
      { ...base, statementId: 'count', subject: { entityId: 'session' }, object: undefined, relation: '总数按初始化记录计算', modality: 'normative', polarity: 'positive' },
      { ...base, statementId: 'update', subject: { entityId: 'session' }, object: undefined, relation: '状态更新增加分母', modality: 'normative', polarity: 'negative' },
    ];
    proposal.draft.evidence = sample.roles.map((role, index) => ({ ...proposal.draft.evidence[0], evidenceLinkId: role.roleKey,
      evidenceRef: `${sample.caseId}:0`, statementIds: [proposal.draft.content.statements[index].statementId] }));
    proposal.citations = sample.roles.map(role => ({ evidenceLinkId: role.roleKey,
      selection: { evidenceRef: `${sample.caseId}:0`, ...role.anchor } }));
    const checked = checkEntityReview(sample, checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts));
    expect(checked.roles.map(role => role.observed.map(statement => ({ relation: statement.relation, polarity: statement.polarity, modality: statement.modality })))).toEqual([
      [{ relation: '总数按初始化记录计算', polarity: 'positive', modality: 'normative' }],
      [{ relation: '状态更新增加分母', polarity: 'negative', modality: 'normative' }],
    ]);
    expect(checked.roles.every(role => role.semanticReview === 'pending')).toBe(true);
    expect(checked.semanticReview).toBe('pending');
  });

  it.each([
    { caseId: 'dev-necessity-versus-prohibition', action: '修改', predicates: ['需要修改', '修改', '修改'],
      modalities: ['descriptive', 'normative', 'normative'], polarities: ['negative', 'negative', 'positive'] },
    { caseId: 'dev-absence-versus-permission', action: '修改', predicates: ['修改受到禁止', '修改', '修改'],
      modalities: ['descriptive', 'permission', 'permission'], polarities: ['negative', 'positive', 'negative'] },
    { caseId: 'dev-reported-modal-scope', action: 'restart', predicates: ['needs to restart', 'restart'],
      modalities: ['descriptive', 'normative'], polarities: ['negative', 'negative'] },
    { caseId: 'dev-conditional-necessity', action: '执行迁移', predicates: ['需要执行迁移', '执行迁移'],
      modalities: ['descriptive', 'normative'], polarities: ['negative', 'positive'] },
    { caseId: 'held-material-modal-scope', action: '更换', predicates: ['需要更换', '更换为未认证的配方'],
      modalities: ['descriptive', 'normative'], polarities: ['negative', 'negative'] },
    { caseId: 'held-repair-permission-scope', action: '拆开', predicates: ['拆开受到禁止', '拆开'],
      modalities: ['descriptive', 'permission'], polarities: ['negative', 'positive'] },
  ] as const)('exposes modal scope and its corrupted alternative for $caseId without pretending to judge semantics', expected => {
    const sample = corpus.cases.find(value => value.caseId === expected.caseId)!;
    const output = modelWindow();
    output.entities = [{ ...output.entities[0], entityId: 'target', label: sample.mentions[0].alternatives[0].quote }];
    output.mentions = sample.mentions.map(value => ({ ...output.mentions[0], mentionId: value.mentionKey, entityId: 'target',
      selection: { evidenceRef: `${sample.caseId}:${value.messageIndex}`, ...value.alternatives[0] } }));
    const proposal = output.proposals[0];
    proposal.entityIds = ['target']; proposal.mentionIds = output.mentions.map(value => value.mentionId);
    const base = proposal.draft.content.statements[0];
    proposal.draft.content.statements = sample.roles.map((role, index) => ({ ...base, statementId: role.roleKey,
      subject: { entityId: 'target' }, object: undefined, relation: expected.predicates[index],
      modality: expected.modalities[index], polarity: expected.polarities[index],
      context: { ...base.context, scenario: sample.messages[role.messageIndex].text } }));
    proposal.draft.evidence = sample.roles.map(role => ({ ...proposal.draft.evidence[0], evidenceLinkId: role.roleKey,
      evidenceRef: `${sample.caseId}:${role.messageIndex}`, statementIds: [role.roleKey], basis: 'source_assertion' }));
    proposal.citations = sample.roles.map(role => ({ evidenceLinkId: role.roleKey,
      selection: { evidenceRef: `${sample.caseId}:${role.messageIndex}`, ...role.anchor } }));
    const review = () => {
      const admitted = checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
      expect(admitted.rejected).toEqual([]); expect(admitted.analysis.rejected).toEqual([]);
      if (output.proposals.length) {
        expect(admitted.accepted[0].draft.content.statements[0].context).toEqual(proposal.draft.content.statements[0].context);
        expect(admitted.accepted[0].draft.evidence.every(link => link.basis === 'source_assertion')).toBe(true);
      }
      return checkEntityReview(sample, admitted);
    };
    const checked = review();
    expect(checked.roles.map(role => role.observed.map(statement => ({ relation: statement.relation,
      modality: statement.modality, polarity: statement.polarity })))).toEqual(expected.predicates.map((relation, index) => [
      { relation, modality: expected.modalities[index], polarity: expected.polarities[index] },
    ]));
    expect(checked.roles.every(role => role.semanticReview === 'pending')).toBe(true);
    // Fabricated responses exercise the review path, never the model's extraction quality.
    // A context quoting “no need” cannot repair this stronger, structurally valid prohibition.
    proposal.draft.content.statements[0].relation = expected.action;
    proposal.draft.content.statements[0].modality = 'normative';
    const corrupted = review();
    expect(corrupted.roles[0]).toMatchObject({ endpointStatus: 'endpoints_matched', semanticReview: 'pending',
      observed: [{ relation: expected.action, modality: 'normative', polarity: 'negative' }] });
    expect(entityReviewHtml(corpus, measurementId)).toContain(sample.roles[0].interpretation);
    output.proposals = [];
    expect(review().roles.every(role => role.endpointStatus === 'not_observed' && role.semanticReview === 'pending')).toBe(true);
  });

  it('admits ordinary objects and concepts while detecting same-level homonym merges and alias splits', () => {
    for (const caseId of ['dev-apple-senses', 'held-policy-terms', 'held-material-object', 'held-database-alias', 'held-empty-knowledge']) {
      const sample = corpus.cases.find(value => value.caseId === caseId)!;
      const output = modelWindow(); output.proposals = [];
      output.entities = sample.entities.map(value => ({ ...output.entities[0], entityId: value.entityKey,
        label: value.entityKey, description: value.rationale, referentKind: 'object', componentRef: null, collection: null }));
      output.mentions = sample.mentions.map(value => ({ ...output.mentions[0], mentionId: value.mentionKey, entityId: value.entity,
        selection: { evidenceRef: `${caseId}:${value.messageIndex}`, ...value.alternatives[0] } }));
      const admit = () => checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
      expect(admit().analysis.rejected).toEqual([]);
      const result = checkEntityReview(sample, admit());
      expect(result.criticalMentionRecall.value).toBe(1);
      expect(result.identityPairs.every(pair => pair.status === 'matched')).toBe(true);
      if (sample.entities.length > 1) {
        output.mentions[1].entityId = output.entities[0].entityId;
        expect(checkEntityReview(sample, admit()).identityPairs.some(pair => pair.status === 'wrong_merge')).toBe(true);
      } else {
        output.entities.push({ ...output.entities[0], entityId: 'duplicate' });
        output.mentions[1].entityId = 'duplicate';
        expect(checkEntityReview(sample, admit()).identityPairs.some(pair => pair.status === 'wrong_split')).toBe(true);
      }
    }
  });

  it('uses cited endpoints across synonyms, preserves optional omission and leaves direction conflicts for semantic review', () => {
    const output = packet(); output.proposals[0].draft.content.statements[0].relation = 'employs as a dependency';
    expect(checkEntityReview(sample, check(output)).roles[0]).toMatchObject({ endpointStatus: 'endpoints_matched',
      observed: [{ relation: 'employs as a dependency', modality: 'descriptive', polarity: 'positive' }], semanticReview: 'pending' });
    output.proposals[0].draft.content.statements[0].relation = 'does not employ';
    output.proposals[0].draft.content.statements[0].modality = 'normative';
    output.proposals[0].draft.content.statements[0].polarity = 'negative';
    // Even a potentially double-negated relation remains visible for review; no lexical semantic classifier.
    expect(checkEntityReview(sample, check(output)).roles[0]).toMatchObject({ endpointStatus: 'endpoints_matched',
      observed: [{ relation: 'does not employ', modality: 'normative', polarity: 'negative' }], semanticReview: 'pending' });
    output.proposals[0].draft.content.statements[0].subject.entityId = 'tool';
    output.proposals[0].draft.content.statements[0].object!.entityId = 'project';
    const swapped = checkEntityReview(sample, check(output));
    expect(swapped.roles[0]).toMatchObject({ endpointStatus: 'direction_conflict_needs_review', semanticReview: 'pending' });
    output.proposals = [];
    expect(checkEntityReview(sample, check(output)).roles[0].endpointStatus).toBe('not_observed');
    expect(checkEntityReview(sample, check(output)).unexpectedKnowledge).toBe(false);
    const otherAnchor = structuredClone(sample); otherAnchor.messages.push({ role: 'user', text: 'Unrelated later observation.' });
    otherAnchor.roles[0] = { ...otherAnchor.roles[0], messageIndex: 1, anchor: { quote: 'Unrelated later observation.', occurrence: 0 } };
    expect(checkEntityReview(otherAnchor, check(packet())).roles[0].endpointStatus).toBe('not_observed');
  });

  it('accepts prefrozen backticked instance boundaries without losing component links', () => {
    const instances = corpus.cases.find(value => value.caseId === 'dev-instances')!;
    const raw = modelWindow(); raw.proposals = [];
    raw.entities = ['component', 'test', 'prod'].map((entityId, index) => ({ ...raw.entities[0], entityId, label: entityId,
      referentKind: index === 0 ? 'component' : 'instance',
      componentRef: index === 0 ? null : { entityId: 'component', mentionIds: [entityId], rationale: 'Explicit instance of Sieve.' } }));
    raw.mentions = ['Sieve', '`sieve/dev01`', '`sieve/prod01`'].map((quote, index) => ({ ...raw.mentions[0],
      mentionId: raw.entities[index].entityId, entityId: raw.entities[index].entityId, selection: { evidenceRef: 'dev-instances:0', quote } }));
    const admitted = checkWindowExtractionResponse(raw, entityReviewInput(instances).excerpts);
    expect(admitted.analysis.rejected).toEqual([]);
    const result = checkEntityReview(instances, admitted);
    expect(result.criticalMentionRecall).toEqual({ matched: 3, total: 3, value: 1 });
    expect(result.identities.every(value => value.status === 'matched')).toBe(true);
  });

  it.each(['fresh-type-evidence', 'fresh-shared-property'])('reports unsupported types and shared-reference misattribution in %s', caseId => {
    const value = corpus.cases.find(entry => entry.caseId === caseId)!;
    const base = modelWindow();
    const raw = { ...base, proposals: [],
      entities: value.entities.map(entity => ({ ...base.entities[0], entityId: entity.entityKey, label: entity.entityKey,
        referentKind: entity.referentKinds[0], uncertainties: ['Type or scope remains source-limited.'],
        collection: entity.collection ? { memberEntityIds: entity.collection.members, completeness: entity.collection.completeness,
          mentionIds: value.mentions.filter(mention => mention.entity === entity.entityKey).map(mention => mention.mentionKey), rationale: entity.rationale } : null })),
      mentions: value.mentions.map(mention => ({ ...base.mentions[0], mentionId: mention.mentionKey, entityId: mention.entity,
        selection: { evidenceRef: `${caseId}:${mention.messageIndex}`, ...mention.alternatives[0] } })),
    };
    const admit = () => checkWindowExtractionResponse(raw, entityReviewInput(value).excerpts);
    expect(admit().analysis.rejected).toEqual([]);
    const correct = checkEntityReview(value, admit());
    expect(correct.identities.every(identity => identity.status === 'matched')).toBe(true);
    expect(correct.identityPairs.every(pair => pair.status === 'matched')).toBe(true);
    if (caseId === 'fresh-type-evidence') {
      raw.entities[0].referentKind = 'component';
      expect(checkEntityReview(value, admit()).identities[0]).toMatchObject({ status: 'mismatched', problems: ['referent_kind'] });
    } else {
      raw.mentions.find(mention => mention.mentionId === 'their')!.entityId = 'file-a';
      const incorrect = checkEntityReview(value, admit());
      expect(incorrect.identityPairs.some(pair => pair.status === 'wrong_merge')).toBe(true);
      expect(incorrect.identityPairs.some(pair => pair.status === 'wrong_split')).toBe(true);
    }
    // Production validates structure; source meaning is still subject to explicit review.
    expect(admit().analysis.rejected).toEqual([]);
  });

  it('does not reject source-scoped unresolved knowledge merely because the source is truncated', () => {
    const truncated = corpus.cases.find(value => value.caseId === 'val-truncated')!;
    const raw = modelWindow();
    raw.entities = [{ ...raw.entities[0], entityId: 'unknown', label: '它', identityStatus: 'unresolved',
      uncertainties: ['Source has no antecedent.'] }];
    raw.mentions = [{ ...raw.mentions[0], entityId: 'unknown', selection: { evidenceRef: 'val-truncated:0', quote: '它' } }];
    const proposal = raw.proposals[0]; proposal.entityIds = ['unknown']; proposal.mentionIds = ['m1'];
    proposal.draft.title = '身份未知对象的失败主张，待调查';
    const statement = proposal.draft.content.statements[0];
    statement.subject.entityId = 'unknown'; delete statement.object; statement.relation = '据本条消息失败，尚待调查';
    statement.context.scenario = '仅此截断消息'; statement.context.unknowns = ['主体身份及失败原因未知'];
    proposal.draft.evidence[0].evidenceRef = 'val-truncated:0';
    proposal.citations[0].selection = { evidenceRef: 'val-truncated:0', quote: truncated.messages[0].text };
    proposal.identityUncertainties = ['主体未消解，不补充来源外候选。'];
    const admitted = checkWindowExtractionResponse(raw, entityReviewInput(truncated).excerpts);
    expect(admitted.analysis.rejected).toEqual([]); expect(admitted.rejected).toEqual([]); expect(admitted.accepted).toHaveLength(1);
    const result = checkEntityReview(truncated, admitted);
    expect(result.unexpectedKnowledge).toBe(false); expect(result.identities[0].status).toBe('matched');
    expect(result.semanticReview).toBe('pending');
  });

  it('detects component and membership semantics even when production structure accepts them', () => {
    const collective = corpus.cases.find(value => value.caseId === 'dev-collective')!;
    const raw = { responseKind: 'knowledge-extraction', schemaVersion: 4, proposals: [],
      entities: [
        ...['atlas', 'birch'].map(entityId => ({ entityId, label: entityId, description: 'Named object', qualifiers: [],
          referentKind: 'object', identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], componentRef: null, collection: null })),
        { entityId: 'pair', label: '它们', description: 'Partial membership hypothesis', qualifiers: [], referentKind: 'collection', identityStatus: 'proposed',
          possibleEntityIds: [], uncertainties: ['Missing membership'], componentRef: null,
          collection: { memberEntityIds: ['atlas'], completeness: 'partial', mentionIds: ['pair'], rationale: 'Hypothesized membership' } },
      ],
      mentions: ['Atlas', 'Birch', '它们'].map((quote, index) => ({ mentionId: ['atlas','birch','pair'][index], entityId: ['atlas','birch','pair'][index],
        basis: 'explicit', rationale: 'Named in source', selection: { evidenceRef: 'dev-collective:0', quote } })),
    };
    const checked = checkWindowExtractionResponse(raw, entityReviewInput(collective).excerpts);
    expect(checked.analysis.rejected).toEqual([]);
    expect(checkEntityReview(collective, checked).identities.find(value => value.entity === 'pair')).toMatchObject({ status: 'mismatched', problems: ['membership'] });
    const kind = packet(); kind.entities[0].referentKind = 'component'; kind.proposals = [];
    expect(checkEntityReview(sample, check(kind)).identities[0].problems).toEqual(['referent_kind']);
  });

  it('records capture failures separately from envelope/partial structural rejections and propagates checker defects', () => {
    expect(reviewCapturedOutput(sample, 'not JSON', check).captureStatus).toBe('parse_failure');
    const envelope = reviewCapturedOutput(sample, '{}', check);
    expect(envelope.captureStatus).toBe('captured'); expect(envelope.structuralRejections).toHaveLength(1); expect(envelope.checks).toBeNull();
    const invalid = packet(); invalid.proposals = []; invalid.mentions[1].selection.quote = 'Invented';
    const partial = reviewCapturedOutput(sample, JSON.stringify(invalid), check);
    expect(partial.captureStatus).toBe('captured'); expect(partial.structuralRejections).toHaveLength(2);
    expect(partial.checks?.criticalMentions[1].status).toBe('missing');
    expect(() => reviewCapturedOutput(sample, '{}', () => { throw new Error('Internal defect'); })).toThrow('Internal defect');
  });

  it('preserves planned coverage and raw failures without treating structural rejection as a capture failure', () => {
    const single = { ...corpus, cases: [sample] };
    const artifact = { captureVersion: 'omk-entity-captures/v1', measurementId, split: 'development', repeats: 1, startedAt: '2020-02-01T00:00:00Z', executor: 'fixture', model: 'fixture',
      records: [{ caseId: 'roles', repeat: 1, inputDigest: reviewDigest(JSON.stringify(entityReviewInput(sample))), result: { captureStatus: 'output', output: '{}', usage: { tokens: 10 } } }] };
    const review = () => reviewCapture(JSON.stringify(artifact), single, measurementId, checkWindowExtractionResponse);
    expect(review().summary).toMatchObject({ captureStatus: 'captured', captured: 1, callFailures: 0, parseFailures: 0, structuralRejectingOutputs: 1, rejectedItems: 1, usdCost: 'unknown', semanticReview: 'pending' });
    expect(review().capture.records[0].result).toEqual(artifact.records[0].result);
    const reported = { ...artifact, records: artifact.records.map(record => ({ ...record, result: { ...record.result, costUSD: 0, durationMs: 20 } })) };
    expect(reviewCapture(JSON.stringify(reported), single, measurementId, checkWindowExtractionResponse).summary).toMatchObject({ usdCost: 0, reportedCostUSD: 0, reportedDurationMs: 20, uncheckedCriticalMentions: 2 });
    artifact.records[0].result.output = 'bad'; expect(review().summary).toMatchObject({ captureStatus: 'capture_failures', parseFailures: 1, structuralRejectingOutputs: 0 });
    artifact.records.push(artifact.records[0]); expect(review).toThrow('duplicate'); artifact.records.pop();
    artifact.records[0].inputDigest = reviewDigest('wrong input'); expect(review).toThrow('frozen source input');
    artifact.records = []; expect(review().summary).toMatchObject({ captureStatus: 'incomplete', notAttempted: 1, checkedCriticalMentions: 0, uncheckedCriticalMentions: 2 });
    expect(review().unattempted).toEqual([{ caseId: 'roles', repeat: 1 }]);
    for (const status of ['call_failure', 'cancelled']) {
      const failed = { ...artifact, records: [{ caseId: 'roles', repeat: 1, inputDigest: reviewDigest(JSON.stringify(entityReviewInput(sample))), result: { captureStatus: status, failure: 'Captured failure' } }] };
      expect(reviewCapture(JSON.stringify(failed), single, measurementId, checkWindowExtractionResponse).summary[status === 'call_failure' ? 'callFailures' : 'cancellations']).toBe(1);
    }
  });

  it('cannot mark draft gold reviewed without an independent complete receipt bound before outputs', () => {
    expect(reviewReceiptStatus(undefined, corpus, measurementId).status).toBe('pending');
    expect(reviewReceiptStatus(JSON.stringify(receipt()), corpus, measurementId, '2020-02-01T00:00:00Z').status).toBe('attested_independent_human');
    const changes = receipt(); changes.decisions[0].decision = 'changes_requested';
    expect(reviewReceiptStatus(JSON.stringify(changes), corpus, measurementId).status).toBe('changes_requested');
    for (const mutate of [
      (value: ReturnType<typeof receipt>) => { value.reviewer = corpus.authors[0]; },
      (value: ReturnType<typeof receipt>) => { value.measurementId = reviewDigest('other'); },
      (value: ReturnType<typeof receipt>) => { value.decisions.pop(); },
      (value: ReturnType<typeof receipt>) => { value.decisions[0] = value.decisions[1]; },
      (value: ReturnType<typeof receipt>) => { value.independenceAttestation = false; },
    ]) { const value = receipt(); mutate(value); expect(() => reviewReceiptStatus(JSON.stringify(value), corpus, measurementId)).toThrow(); }
    expect(() => reviewReceiptStatus(JSON.stringify(receipt()), corpus, measurementId, '2019-01-01T00:00:00Z')).toThrow('precede');
    const html = entityReviewHtml({ ...corpus, cases: [{ ...sample, messages: [{ role: 'user', text: '<script>unsafe</script> Alpha drives Beta.' }] }] }, measurementId);
    expect(html).not.toContain('<script>unsafe</script>'); expect(html).toContain('&lt;script&gt;');
    const captured = entityReviewHtml(corpus, measurementId, { annotationReview: 'attested_independent_human', authorReview: 'pending', hasCaptures: true });
    expect(captured).toContain('已提供捕获'); expect(captured).not.toContain('尚无模型输出');
  });

  it('records complete author judgment without counting it as independent approval or overriding disagreements', () => {
    const author = { selfReviewVersion: 'omk-entity-author-review/v1', measurementId, reviewer: corpus.authors[0],
      reviewedAt: '2020-01-01T00:00:00Z', reviewedBeforeOutputs: true, decisions: receipt().decisions };
    const approved = authorReviewStatus(JSON.stringify(author), corpus, measurementId, '2020-02-01T00:00:00Z');
    expect(approved.status).toBe('completed');
    expect(annotationReadiness(approved.status, 'pending')).toEqual({ goldReady: false, exploratoryReady: true });
    expect(annotationReadiness('pending', 'pending')).toEqual({ goldReady: false, exploratoryReady: false });
    expect(annotationReadiness('pending', 'attested_independent_human')).toEqual({ goldReady: true, exploratoryReady: true });
    for (const statuses of [['completed', 'changes_requested'], ['changes_requested', 'attested_independent_human']] as const)
      expect(annotationReadiness(statuses[0], statuses[1])).toEqual({ goldReady: false, exploratoryReady: false });
    const changes = structuredClone(author); changes.decisions[0].decision = 'changes_requested';
    expect(authorReviewStatus(JSON.stringify(changes), corpus, measurementId).status).toBe('changes_requested');
    expect(authorReviewStatus(undefined, corpus, measurementId).status).toBe('pending');
    expect(() => reviewReceiptStatus(JSON.stringify(author), corpus, measurementId)).toThrow();
    for (const mutate of [
      (value: typeof author) => { value.reviewer = 'not-an-author'; },
      (value: typeof author) => { value.measurementId = reviewDigest('other'); },
      (value: typeof author) => { value.decisions.pop(); },
      (value: typeof author) => { value.decisions[0] = value.decisions[1]; },
      (value: typeof author) => { value.decisions[0].rationale = ''; },
      (value: typeof author) => { value.reviewedAt = '2999-01-01T00:00:00Z'; },
    ]) { const value = structuredClone(author); mutate(value); expect(() => authorReviewStatus(JSON.stringify(value), corpus, measurementId)).toThrow(); }
    expect(() => authorReviewStatus(JSON.stringify(author), corpus, measurementId, '2019-01-01T00:00:00Z')).toThrow('precede');
    expect(entityReviewHtml(corpus, measurementId, { annotationReview: 'pending', authorReview: 'completed', hasCaptures: false }))
      .toContain('作者自审：completed；独立人工标注复核：pending');
    expect(parseEntityReviewArguments(['--corpus', '/c', '--output', '/out', '--self-review', '/s'])).toMatchObject({ selfReview: '/s' });
  });

  it('exposes only an explicit offline input/output interface', () => {
    expect(parseEntityReviewArguments(['--corpus', '/corpus', '--output', '/outside/review'])).toMatchObject({ corpus: '/corpus', output: '/outside/review' });
    for (const args of [[], ['--model', 'model'], ['--corpus', '/corpus'], ['--corpus', '/corpus', '--output', '/outside', '--output', '/again']]) expect(() => parseEntityReviewArguments(args)).toThrow();
  });
});
