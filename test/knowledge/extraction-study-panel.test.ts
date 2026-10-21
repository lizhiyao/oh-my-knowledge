import { describe, expect, it } from 'vitest';
import { extractionStudyDigest } from '../../src/knowledge/extraction/study-corpus.js';
import { createExtractionStudyPanel, evaluateExtractionStudyPanel, extractionStudyPanelBytesDigest as bytes,
  parseExtractionStudyPanel, type ExtractionStudyPanel } from '../../src/knowledge/extraction/study-panel.js';
import type { ExtractionStudyOutputReceipt } from '../../src/knowledge/extraction/study-review.js';
import { studyFixture, studyJudgeIdentity } from './extraction-study-fixtures.js';

// All people, signatures, judgments and sources below are authored test data, never human/measurement evidence.
function fixture() {
  const f = studyFixture(), context = { ...f.input, outputReceipt: undefined, evidenceDigest: bytes('authored raw portable evidence') };
  const declaration = (actorId: string) => ({ reviewer: { actorKind: 'human' as const, actorId }, independentHuman: true,
    authorRelationship: 'non_author' as const, independenceRationale: 'Fictional independent identity for a unit fixture only.' });
  const roster = { raters: [declaration('fictional-a'), declaration('fictional-b')], adjudicator: declaration('fictional-third') };
  let panel = createExtractionStudyPanel(context, { declaredAt: '2020-02-10T00:00:00Z', analysisMode: 'prospective', roster });
  const receipts = roster.raters.map(value => ({ ...structuredClone(f.receipt), reviewer: value.reviewer }));
  const evaluate = (selected: ExtractionStudyOutputReceipt[] = receipts, extra: Partial<Parameters<typeof evaluateExtractionStudyPanel>[0]> = {}) => {
    const raws = selected.map((receipt, index) => ({ receiptFile: `${index}.json`, raw: JSON.stringify(receipt, null, 2) + '\n' }));
    const submissionRaw = JSON.stringify({ submissionVersion: 'omk-extraction-study-panel-submission/v1', panelId: panel.panelId,
      receipts: selected.map((receipt, index) => ({ reviewerId: receipt.reviewer.actorId, receiptFile: raws[index].receiptFile, receiptDigest: bytes(raws[index].raw) })) });
    return evaluateExtractionStudyPanel({ context, panel, submissionRaw, receipts: raws, ...extra });
  };
  return { f, context, roster, receipts, evaluate, get panel() { return panel; }, set panel(value: ExtractionStudyPanel) { panel = value; } };
}

describe('independent study output panel', () => {
  it('binds all eight target kinds and computes exact pre-adjudication agreement without quality acceptance', () => {
    const f = fixture(), report = f.evaluate();
    expect(new Set(f.panel.targets.map(value => value.itemKind))).toEqual(new Set(['entity', 'mention', 'statement', 'reference_entity', 'reference_mention', 'knowledge_obligation', 'semantic_check', 'case']));
    expect(report).toMatchObject({ reportVersion: 'omk-extraction-study-panel-report/v1', qualityAcceptance: 'not_assessed', fullIAA: 1,
      participants: { humans: 2, agents: 0, eligibleHumansSubmitted: 2 }, fullIAAUnavailableReasons: [], observed: { exactAgreementRate: 1 } });
    expect(report.observed.commonDefiniteTargets).toBe(f.panel.targets.length);
    expect(report.pairwise).toHaveLength(1);
    expect(report).not.toHaveProperty('goldReady');
    expect(f.evaluate().reportId).toBe(report.reportId);
  });

  it('includes critical reference omission disagreement in the main denominator even when every output decision agrees', () => {
    const f = fixture(), target = f.receipts[1].decisions.find(value => value.target.itemKind === 'knowledge_obligation')!;
    target.verdict = 'required_missing';
    const report = f.evaluate();
    expect(report.fullIAA).toBeLessThan(1);
    expect(report.disagreements).toHaveLength(1);
    expect(report.disagreements[0].target.itemKind).toBe('knowledge_obligation');
    expect(report.coverage[1].requiredMissingTargets).toHaveLength(1);
    const coverage = report.observed.errorCategories.find(value => value.errorCode === 'coverage')!;
    expect(coverage).toMatchObject({ commonDefiniteTargets: f.panel.targets.length, agreement: f.panel.targets.length - 1 });
    expect(coverage.agreementRate).toBeLessThan(1);
    expect(coverage.presentByReviewer).toEqual([
      { reviewer: f.roster.raters[0].reviewer, count: 0 }, { reviewer: f.roster.raters[1].reviewer, count: 1 },
    ]);
    expect(report.pairwise[0].errorCategories.find(value => value.errorCode === 'coverage')).toEqual(coverage);
    expect(target.errorCodes).toEqual([]);
    expect(report.disagreements[0].recorded.find(value => value.decision.verdict === 'required_missing')?.decision.errorCodes).toEqual([]);
    expect(report.observed.byItemKind.find(value => value.itemKind === 'knowledge_obligation')).toMatchObject({ commonDefiniteTargets: 2, exactAgreement: 1, exactAgreementRate: 0.5 });
    expect(report.observed.byItemKind.find(value => value.itemKind === 'statement')?.exactAgreementRate).toBe(1);
  });

  it('compares error categories and reference matches independently from the verdict', () => {
    const f = fixture();
    for (const receipt of f.receipts) {
      const decision = receipt.decisions.find(value => value.target.itemKind === 'case')!;
      decision.verdict = 'incorrect'; decision.errorCodes = ['coverage'];
    }
    f.receipts[1].decisions.find(value => value.target.itemKind === 'case')!.errorCodes = ['provenance'];
    const report = f.evaluate();
    expect(report.disagreements).toHaveLength(1);
    expect(report.observed.verdictAgreementRate).toBe(1);
    expect(report.observed.exactAgreementRate).toBeLessThan(1);
    expect(report.observed.errorCategories.find(value => value.errorCode === 'coverage')?.agreementRate).toBeLessThan(1);
    expect(report.observed.referenceMatching.find(value => value.itemKind === 'entity')).toMatchObject({ agreementRate: 1, allMatchedTargets: 4 });
    const before = report.reportId;
    // Coherent incorrect/unmatched output changes both output and its reference coverage judgments.
    const selected = f.receipts[1].decisions.find(value => value.target.itemKind === 'entity')!;
    const referenceId = selected.referenceId, slotId = selected.target.slotId;
    selected.referenceId = null; selected.verdict = 'incorrect'; selected.errorCodes = ['identity'];
    for (const decision of f.receipts[1].decisions) {
      if (decision.target.slotId !== slotId) continue;
      if (decision.target.itemKind === 'reference_entity' && decision.target.referenceId === referenceId) decision.verdict = 'required_missing';
      if (decision.target.itemKind === 'mention' && decision.referenceId
        && f.f.corpus.cases[0].reference.mentions.find(value => value.referenceId === decision.referenceId)?.entityReferenceId === referenceId) {
        const mentionReference = decision.referenceId;
        decision.referenceId = null; decision.verdict = 'incorrect'; decision.errorCodes = ['identity'];
        const coverage = f.receipts[1].decisions.find(value => value.target.slotId === slotId && value.target.itemKind === 'reference_mention' && value.target.referenceId === mentionReference)!;
        coverage.verdict = 'required_missing';
      }
    }
    const changed = f.evaluate();
    expect(changed.reportId).not.toBe(before);
    expect(changed.observed.referenceMatching.find(value => value.itemKind === 'entity')?.agreementRate).toBeLessThan(1);
    expect(changed.observed.referenceMatching.find(value => value.itemKind === 'entity')?.byReference.find(value => value.slotId === slotId && value.referenceId === referenceId)?.agreementRate).toBeLessThan(1);
  });

  it('retains observed pairwise agreement while missing people/items and uncertain judgments prevent full IAA', () => {
    const f = fixture(), absent = f.evaluate([f.receipts[0]]);
    expect(absent.fullIAA).toBeNull();
    expect(absent.fullIAAUnavailableReasons).toContain('missing_roster_receipt');
    expect(absent.participants).toMatchObject({ eligibleHumansPlanned: 2, eligibleHumansSubmitted: 1 });
    expect(absent.observed.commonDefiniteTargets).toBe(0);
    f.receipts[1].decisions.pop();
    f.receipts[1].decisions.find(value => value.target.itemKind === 'semantic_check')!.verdict = 'uncertain';
    const partial = f.evaluate();
    expect(partial.fullIAA).toBeNull();
    expect(partial.fullIAAUnavailableReasons).toEqual(expect.arrayContaining(['incomplete_target_coverage', 'uncertain_judgments']));
    expect(partial.observed.exactAgreementRate).toBe(1);
    expect(partial.observed.commonDefiniteTargets).toBe(f.panel.targets.length - 2);
    expect(partial.coverage[1].missingTargets).toHaveLength(1);
    expect(partial.coverage[1].uncertainTargets).toHaveLength(1);
  });

  it('preserves the actually submitted human intersection when another declared human is missing', () => {
    const f = fixture();
    f.panel = createExtractionStudyPanel(f.context, { declaredAt: f.panel.declaredAt, analysisMode: 'prospective', roster: {
      ...f.roster, raters: [...f.roster.raters, { ...f.roster.raters[0], reviewer: { actorKind: 'human', actorId: 'fictional-missing' } }],
    } });
    const report = f.evaluate();
    expect(report).toMatchObject({ fullIAA: null, participants: { eligibleHumansPlanned: 3, eligibleHumansSubmitted: 2 },
      observed: { commonDefiniteTargets: f.panel.targets.length, exactAgreementRate: 1 } });
    expect(report.observed.reviewers).toHaveLength(2);
    expect(report.pairwise).toHaveLength(3);
    expect(report.pairwise.filter(value => value.commonDefiniteTargets > 0)).toHaveLength(1);
    expect(report.fullIAAUnavailableReasons).toContain('missing_roster_receipt');
  });

  it('keeps agent and non-independent declarations but never counts either as a second independent human', () => {
    const f = fixture(), agent = { reviewer: { actorKind: 'agent' as const, actorId: 'fictional-ai' }, independentHuman: false,
      authorRelationship: 'non_author' as const, independenceRationale: 'Authored agent fixture; never an independent human.' };
    f.panel = createExtractionStudyPanel(f.context, { declaredAt: f.panel.declaredAt, analysisMode: 'prospective', roster: { ...f.roster, raters: [f.roster.raters[0], agent] } });
    const receipt = { ...f.receipts[1], reviewer: agent.reviewer, independentHuman: false, judgeIdentity: studyJudgeIdentity() };
    const report = f.evaluate([f.receipts[0], receipt]);
    expect(report).toMatchObject({ fullIAA: null, participants: { humans: 1, agents: 1, eligibleHumansSubmitted: 1 }, pairwise: [] });
    expect(report.fullIAAUnavailableReasons).toContain('fewer_than_two_eligible_humans');
    const author = { ...f.roster.raters[1], reviewer: { actorKind: 'human' as const, actorId: 'author' }, authorRelationship: 'author', independentHuman: false };
    f.panel = createExtractionStudyPanel(f.context, { declaredAt: f.panel.declaredAt, analysisMode: 'prospective', roster: { ...f.roster, raters: [f.roster.raters[0], author] } });
    const authored = f.evaluate([f.receipts[0], { ...f.receipts[1], reviewer: author.reviewer, independentHuman: false }]);
    expect(authored.participants.nonIndependentHumans).toBe(1); expect(authored.fullIAA).toBeNull();
  });

  it('requires prospective declaration strictly before every initial judgment and marks retrospective analysis explicitly', () => {
    const f = fixture();
    for (const declaredAt of ['2020-03-01T00:00:00Z', '2020-03-01T00:00:00.001Z']) {
      f.panel = createExtractionStudyPanel(f.context, { declaredAt, analysisMode: 'prospective', roster: f.roster });
      expect(() => f.evaluate()).toThrow('strictly before');
    }
    f.panel = createExtractionStudyPanel(f.context, { declaredAt: f.context.now, analysisMode: 'retrospective', roster: f.roster });
    expect(f.evaluate()).toMatchObject({ fullIAA: null, analysisMode: 'retrospective', observed: { exactAgreementRate: 1 }, fullIAAUnavailableReasons: ['retrospective_panel'] });
    expect(() => createExtractionStudyPanel(f.context, { declaredAt: '2020-04-02T00:00:00Z', analysisMode: 'retrospective', roster: f.roster })).toThrow('identity mismatch');
  });

  it('rejects substituted evidence, missing protocol versions, bad roster independence and reused adjudicators', () => {
    const f = fixture();
    const unversioned: Partial<typeof f.panel> = { ...f.panel }; delete unversioned.panelVersion;
    expect(() => parseExtractionStudyPanel(unversioned, f.context)).toThrow();
    expect(() => parseExtractionStudyPanel(f.panel, { ...f.context, evidenceDigest: bytes('other raw') })).toThrow('identity mismatch');
    expect(() => parseExtractionStudyPanel({ ...f.panel, targetSetDigest: extractionStudyDigest([]) }, f.context)).toThrow('identity mismatch');
    expect(() => createExtractionStudyPanel(f.context, { declaredAt: f.panel.declaredAt, analysisMode: 'prospective', roster: { ...f.roster, adjudicator: f.roster.raters[0] } })).toThrow('distinct');
    expect(() => createExtractionStudyPanel(f.context, { declaredAt: f.panel.declaredAt, analysisMode: 'prospective', roster: { ...f.roster, raters: [{ ...f.roster.raters[0], reviewer: { actorKind: 'human', actorId: 'author' } }] } })).toThrow('independence');
  });

  it('rejects unknown/duplicate reviewers, targets, receipts and byte substitutions rather than selecting a favorable receipt', () => {
    const f = fixture();
    expect(() => f.evaluate([f.receipts[0], f.receipts[0]])).toThrow('Duplicate');
    expect(() => f.evaluate([{ ...f.receipts[0], reviewer: { actorKind: 'human', actorId: 'outsider' } }])).toThrow('unknown');
    expect(() => f.evaluate(undefined, { receipts: [] })).toThrow('inventory');
    const decision = f.receipts[1].decisions.find(value => value.target.itemKind === 'case')!;
    f.receipts[1].decisions.push(decision); expect(() => f.evaluate()).toThrow('Duplicate or unknown'); f.receipts[1].decisions.pop();
    decision.target = { slotId: 'unknown', itemKind: 'case' }; expect(() => f.evaluate()).toThrow('Duplicate or unknown');
    const raw = JSON.stringify(f.receipts[0]);
    const manifest = JSON.stringify({ submissionVersion: 'omk-extraction-study-panel-submission/v1', panelId: f.panel.panelId,
      receipts: [{ reviewerId: f.receipts[0].reviewer.actorId, receiptFile: 'original.json', receiptDigest: bytes(raw) }] });
    expect(() => f.evaluate([], { submissionRaw: manifest, receipts: [{ receiptFile: 'original.json', raw: raw + '\n' }] })).toThrow('bytes changed');
  });

  it('binds a third human adjudication to all original receipts and preserves initial IAA and disputes', () => {
    const f = fixture();
    f.receipts[1].decisions.find(value => value.target.itemKind === 'knowledge_obligation')!.verdict = 'required_missing';
    const before = f.evaluate(), third = { ...structuredClone(f.receipts[0]), reviewer: f.roster.adjudicator.reviewer, reviewedAt: '2020-03-02T00:00:00Z' };
    const reviewReceiptRaw = JSON.stringify(third, null, 2) + '\n';
    const envelope = { adjudicationVersion: 'omk-extraction-study-panel-adjudication/v1', panelId: f.panel.panelId,
      initialSetDigest: before.initialSetDigest, disputedTargetsDigest: before.disputedTargetsDigest,
      reviewReceiptFile: 'third.json', reviewReceiptDigest: bytes(reviewReceiptRaw) };
    const adjudication = { raw: JSON.stringify(envelope), reviewReceiptRaw }, after = f.evaluate(undefined, { adjudication });
    expect(after.fullIAA).toBe(before.fullIAA); expect(after.disagreements).toEqual(before.disagreements);
    expect(after.adjudication).toMatchObject({ resolved: 1, unresolvedTargets: [], receiptDigest: bytes(reviewReceiptRaw) });
    expect(after.adjudication?.decisions[0]).toMatchObject({ rawReceiptDigest: bytes(reviewReceiptRaw), canonicalDecisionDigest: extractionStudyDigest(third.decisions.find(value => value.target.itemKind === 'knowledge_obligation')!) });
    expect(() => f.evaluate(undefined, { adjudication: { ...adjudication, raw: JSON.stringify({ ...envelope, initialSetDigest: bytes('subset') }) } })).toThrow('complete initial');
    const wrong = JSON.stringify({ ...third, reviewer: f.roster.raters[0].reviewer });
    expect(() => f.evaluate(undefined, { adjudication: { raw: JSON.stringify({ ...envelope, reviewReceiptDigest: bytes(wrong) }), reviewReceiptRaw: wrong } })).toThrow('third human');
    const early = JSON.stringify({ ...third, reviewedAt: f.receipts[0].reviewedAt });
    expect(() => f.evaluate(undefined, { adjudication: { raw: JSON.stringify({ ...envelope, reviewReceiptDigest: bytes(early) }), reviewReceiptRaw: early } })).toThrow('after all initial');
    const changed = structuredClone(f.receipts); changed[0].decisions[0].rationale += ' corrected declaration';
    expect(() => f.evaluate(changed, { adjudication })).toThrow('complete initial');
  });

  it('does not retroactively appoint an earlier adjudicator while allowing the panel declaration boundary', () => {
    const f = fixture();
    f.receipts[1].decisions.find(value => value.target.itemKind === 'knowledge_obligation')!.verdict = 'required_missing';
    f.panel = createExtractionStudyPanel(f.context, { declaredAt: '2020-03-10T00:00:00Z', analysisMode: 'retrospective', roster: f.roster });
    const before = f.evaluate();
    const adjudicate = (reviewedAt: string) => {
      const reviewReceiptRaw = JSON.stringify({ ...structuredClone(f.receipts[0]), reviewer: f.roster.adjudicator.reviewer, reviewedAt });
      return f.evaluate(undefined, { adjudication: { reviewReceiptRaw, raw: JSON.stringify({
        adjudicationVersion: 'omk-extraction-study-panel-adjudication/v1', panelId: f.panel.panelId,
        initialSetDigest: before.initialSetDigest, disputedTargetsDigest: before.disputedTargetsDigest,
        reviewReceiptFile: 'third.json', reviewReceiptDigest: bytes(reviewReceiptRaw),
      }) } });
    };
    // This receipt is after both initial judgments but before the third person's appointment.
    expect(() => adjudicate('2020-03-09T23:59:59.999Z')).toThrow('no earlier than panel declaration');
    for (const reviewedAt of ['2020-03-10T00:00:00Z', '2020-03-10T00:00:00.001Z']) {
      const after = adjudicate(reviewedAt);
      expect(after.adjudication).toMatchObject({ reviewedAt, resolved: 1, unresolvedTargets: [] });
      expect(after.fullIAA).toBeNull();
      expect(after.fullIAAUnavailableReasons).toContain('retrospective_panel');
      expect(after.disagreements).toEqual(before.disagreements);
    }
  });

  it('does not use missing completion times to qualify complete IAA and cannot adjudicate an incomplete initial roster', () => {
    const f = fixture();
    delete f.context.slots[0].run!.finishedAt;
    expect(f.evaluate()).toMatchObject({ fullIAA: null, observed: { exactAgreementRate: 1 } });
    expect(f.evaluate().fullIAAUnavailableReasons).toContain('incomplete_native_or_completion_evidence');
    const pending = f.evaluate([f.receipts[0]]), raw = JSON.stringify({ ...f.receipts[0], reviewer: f.roster.adjudicator.reviewer, reviewedAt: '2020-03-02T00:00:00Z' });
    expect(() => f.evaluate([f.receipts[0]], { adjudication: { raw: JSON.stringify({ adjudicationVersion: 'omk-extraction-study-panel-adjudication/v1', panelId: f.panel.panelId,
      initialSetDigest: pending.initialSetDigest, disputedTargetsDigest: pending.disputedTargetsDigest, reviewReceiptFile: 'third.json', reviewReceiptDigest: bytes(raw) }), reviewReceiptRaw: raw } })).toThrow('complete initial');
  });
});
