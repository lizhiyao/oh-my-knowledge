import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWindowExtractionResponse } from '../../src/observability/knowledge-extraction/window-proposals.js';
import { ENTITY_CHECK_VERSION, entityReviewInput, parseEntityReviewCorpus, reviewMentions, type EntityReviewCase } from '../../scripts/bench/entity-review-corpus.js';
import { checkEntityReview, reviewCapturedOutput } from '../../scripts/bench/entity-review-checks.js';
import { annotationReadiness, authorReviewStatus, entityReviewHtml, parseEntityReviewArguments, reviewCapture, reviewDigest, reviewReceiptStatus } from '../../scripts/bench/entity-extraction-review.js';
import { modelWindow } from '../knowledge/fixtures.js';

const corpusText = readFileSync(new URL('../fixtures/entity-extraction-review-v7.json', import.meta.url), 'utf8');
const corpus = parseEntityReviewCorpus(corpusText);
const measurementId = reviewDigest('frozen measurement');
const sample: EntityReviewCase = {
  caseId: 'roles', projectGroup: 'project', conversationGroup: 'conversation', split: 'development',
  messages: [{ role: 'user', text: 'Alpha drives Beta.' }], limitations: ['Selected messages only.'], tags: ['roles'],
  entities: ['alpha', 'beta'].map(entityKey => ({ entityKey, referentKinds: ['object'], identityStatus: 'proposed', possibleEntities: [],
    component: null, collection: null, rationale: 'Distinct objects.' })),
  mentions: ['Alpha', 'Beta'].map(quote => ({ mentionKey: quote.toLowerCase(), entity: quote.toLowerCase(), messageIndex: 0,
    alternatives: [{ quote, occurrence: 0 }], rationale: 'Explicit name.' })),
  roles: [{ roleKey: 'drives', subject: 'alpha', object: 'beta', messageIndex: 0,
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
  it.each([
    { version: 'v6', windows: 36, calls: 11, critical: 40, matched: 39, missing: 1, notEvaluable: 3, unattempted: 25, conclusion: 'selected_strict_regression_not_passed' },
    { version: 'v7', windows: 42, calls: 6, critical: 22, matched: 20, missing: 2, notEvaluable: 11, unattempted: 36, conclusion: 'targeted_behaviors_observed_strict_regression_not_passed' },
  ])('replays $version diagnostic without hiding unattempted windows, misses or missing independent evidence', expected => {
    type Capture = ReturnType<typeof reviewCapture>['capture'];
    type Outcome = ReturnType<typeof reviewCapturedOutput>;
    const evidence = JSON.parse(readFileSync(new URL(`../../docs/public/entity-extraction-${expected.version}-diagnostic.json`, import.meta.url), 'utf8')) as {
      conclusion: string; goldReady: boolean; annotationReview: string;
      manifest: { measurementId: string; corpusDigest: string; guideDigest: string; promptHash: string; checkVersion: string };
      frozen: { corpusText: string; guides: { en: string; zh: string }; prompt: { prompt: string }; identity: Record<string, unknown>; authorReview?: unknown };
      execution: { selectedCaseIds: string[]; repeats: number; maxCalls: number; attempted: number; recorded: number; status?: string; executorInvocations?: number; startedAt?: string };
      captureCompletion?: { status: string; planned: number; recorded: number; executorInvocations: number; originalDriverStatus: string; driverExitCode: number; localDriverIssue: string };
      captures: Capture[]; records: (Outcome & { caseId: string; outputDigest: string })[];
      agentReview: { status: string; independentHumanReview: string; decisions: { caseId: string; outputDigest: string; rationale: string }[] };
      statistics: { plannedCriticalMentions: number; matchedCriticalMentions: number; missingCriticalMentions: number; notEvaluableIdentityPairs: number; wrongMerges: number; wrongSplits: number; identityMismatches: number; structuralRejectingOutputs: number; usdCost: string; reportedCostUSD: null };
      fullCorpusSplitSummaries: { split: string; notAttempted: number; captureStatus: string }[];
      reproducibility: { captureDriverText: string; captureDriverDigest: string };
    };
    expect(evidence.manifest.checkVersion).toBe(ENTITY_CHECK_VERSION);
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
      const replayed = reviewCapturedOutput(sample, record.result.output,
        response => checkWindowExtractionResponse(response, input.excerpts));
      const published = evidence.records.find(outcome => outcome.caseId === record.caseId)!;
      expect(published.outputDigest).toBe(reviewDigest(record.result.output));
      expect({ captureStatus: published.captureStatus, structuralRejections: published.structuralRejections, checks: published.checks })
        .toEqual(JSON.parse(JSON.stringify({ captureStatus: replayed.captureStatus, structuralRejections: replayed.structuralRejections, checks: replayed.checks })));
      const decision = evidence.agentReview.decisions.filter(value => value.caseId === record.caseId);
      expect(decision).toHaveLength(1); expect(decision[0].outputDigest).toBe(published.outputDigest);
      expect(decision[0].rationale.length).toBeGreaterThan(20);
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
    if (expected.version === 'v7') {
      expect(evidence.execution).toMatchObject({ status: 'incomplete', executorInvocations: 6 });
      expect(evidence.captureCompletion).toMatchObject({ status: 'captured', planned: 6, recorded: 6, executorInvocations: 6, originalDriverStatus: 'incomplete', driverExitCode: 1 });
      expect(evidence.captureCompletion!.localDriverIssue).toContain('state.recorded === 11');
      expect(evidence.reproducibility.captureDriverText).toContain('state.recorded === 11');
      expect(authorReviewStatus(JSON.stringify(evidence.frozen.authorReview), parseEntityReviewCorpus(evidence.frozen.corpusText), evidence.manifest.measurementId, evidence.execution.startedAt).status).toBe('completed');
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
    expect(corpus.cases.filter(value => value.split === 'development')).toHaveLength(40);
    expect(corpus.cases.filter(value => value.split === 'validation')).toHaveLength(2);
    expect(corpus.cases.reduce((count, value) => count + value.mentions.length, 0)).toBe(150);
    for (const mutate of [
      (copy: typeof corpus) => { copy.cases[40].projectGroup = copy.cases[0].projectGroup; },
      (copy: typeof corpus) => { copy.cases[40].conversationGroup = copy.cases[0].conversationGroup; },
      (copy: typeof corpus) => { copy.cases[40].messages = copy.cases[0].messages; },
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
    for (const field of ['referentKinds', 'semanticChecks', 'projectGroup', 'split', 'alternatives']) expect(JSON.stringify(input)).not.toContain(field);
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
    expect(corpus.cases.slice(0, 40).every(value => value.split === 'development')).toBe(true);
    const rule = corpus.cases.find(value => value.caseId === 'fresh-negative-requirement')!;
    expect(rule.mentions.find(value => value.mentionKey === 'rule-first')!.alternatives).toEqual([
      { quote: 'F9', occurrence: 0 }, { quote: 'Rule F9', occurrence: 0 },
    ]);
    const replaced = reviewMentions(corpus.cases.find(value => value.caseId === 'dev-replacement')!);
    expect(replaced.slice(0, 2).map(value => value.spans[0].quote)).toEqual(['config.json', 'config.json']);
    expect(replaced[0].entity).not.toBe(replaced[1].entity);
    expect(replaced[0].spans[0].start).not.toBe(replaced[1].spans[0].start);
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

  it('detects omitted concepts and premature disambiguation in v7 without rejecting valid nested spans or explicit clarification', () => {
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
        expect(missing.criticalMentions.filter(value => value.status === 'matched')).toHaveLength(3);
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
