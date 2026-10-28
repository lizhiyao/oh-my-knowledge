import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectExtractionStudy } from '../../src/knowledge/application/study-inspection.js';
import { ExtractionStudyInspectionError } from '../../src/knowledge/adapters/study-inspection-errors.js';
import * as studyHost from '../../src/knowledge/adapters/study-host.js';
import { EXTRACTION_STUDY_INSPECTION_MAX_BYTES } from '../../src/knowledge/extraction/study-capacity.js';
import { extractionStudyDigest } from '../../src/knowledge/extraction/study-corpus.js';
import { nativeStudyEvidenceFixture, nativeStudyFixture, studyNativeResult } from './extraction-study-fixtures.js';

const roots: string[] = [];
const root = () => { const value = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-inspection-'))); roots.push(value); return value; };
afterEach(() => { vi.restoreAllMocks(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('shared portable study inspection', () => {
  it('replays explicitly synthetic frozen archives, preserves scoped review, and exposes only the product whitelist', async () => {
    const f = await nativeStudyEvidenceFixture(root(), { annotated: true, reply: (_index, output) => ({
      ...studyNativeResult(output), privateNativeDiagnostic: 'PRIVATE-NATIVE-INSPECTION-SENTINEL',
    }) });
    const judge = f.judgeReceipt.judgeIdentity!;
    judge.attempts[0].runEvidence.reference = '/private/PRIVATE-JUDGE-RUN-PATH';
    judge.attempts[0].outputEvidence!.reference = '/private/PRIVATE-JUDGE-OUTPUT-PATH';
    vi.spyOn(studyHost, 'extractionStudyHostIdentity').mockImplementation(f.ports.identity);
    const input = { evidence: f.evidence, authorReceipt: f.authorReceipt, referenceReceipt: f.referenceReceipt,
      outputReceipt: f.outputReceipt, judgeReceipt: f.judgeReceipt };
    const before = JSON.stringify(input), saved = JSON.stringify(f.files.evidence(f.plan)), calls = f.effects.mock.calls.length;
    const value = inspectExtractionStudy(input), text = JSON.stringify(value);
    expect(value).toMatchObject({ inspectionVersion: 'omk-extraction-study-inspection/v2', modelCallsByThisCommand: 0,
      plan: { planId: f.plan.planId, split: 'development', sampling: { unit: 'lineage-group' } },
      summary: { planned: 2, completed: 2, totalCostUSD: null }, review: { status: 'accepted_within_scope', reference: { goldReady: true } },
      calibration: { ready: true, judgeEvidence: { nativeVerification: 'not_performed', identity: { modelRevision: 'authored-model-r1' },
        usage: { costUSD: { total: null, knownTotal: null, unknownAttempts: 1 } } } } });
    expect(value.cases[0].source.excerpts[0].text).toBe('Alpha 使用 Beta');
    expect(value.slots[0].birth).toMatchObject({ analysisId: f.plan.slots[0].runId, entities: [{ label: 'Alpha' }, { label: 'Beta' }],
      knowledge: [{ content: { statements: [{ relation: '使用' }] }, grounding: { citations: [{ selection: { quote: 'Alpha 使用 Beta' } }] } }] });
    expect(value.review.targets).toHaveLength(value.review.decisions.length); expect(value.review.missingTargets).toEqual([]);
    expect(value.slots.every(slot => slot.elapsedStatus === 'observed' && slot.elapsedMs !== null && slot.elapsedMs >= 0)).toBe(true);
    expect(value.slots[0].elapsedMs).toBe(Date.parse(value.slots[0].finishedAt!) - Date.parse(value.slots[0].startedAt!));
    expect(value.timing).toMatchObject({ unit: 'milliseconds', scope: 'local-run-wall-clock' });
    expect(value.timing.description).toContain('not active human review duration');
    for (const secret of [f.root, 'PRIVATE-NATIVE-INSPECTION-SENTINEL', 'PRIVATE-JUDGE-RUN-PATH', 'PRIVATE-JUDGE-OUTPUT-PATH',
      '"run":', '"rawOutput":', '"outcome":', '"raw":', '"sourcePath":', '"proof":']) expect(text).not.toContain(secret);
    expect(value.calibration!.judgeEvidence.identity!.attempts[0].runEvidence).toEqual({ digest: judge.attempts[0].runEvidence.digest });
    expect(JSON.stringify(input)).toBe(before); expect(JSON.stringify(f.files.evidence(f.plan))).toBe(saved); expect(f.effects).toHaveBeenCalledTimes(calls);
  });

  it('projects v2 completion-time blockers without backfilling original completed run files', async () => {
    const f = await nativeStudyEvidenceFixture(root(), { annotated: true, withoutCompletedFinish: true });
    vi.spyOn(studyHost, 'extractionStudyHostIdentity').mockImplementation(f.ports.identity);
    const before = JSON.stringify(f.files.evidence(f.plan)), input = { evidence: f.evidence, authorReceipt: f.authorReceipt,
      referenceReceipt: f.referenceReceipt, outputReceipt: f.outputReceipt, judgeReceipt: f.judgeReceipt };
    const value = inspectExtractionStudy(input);
    expect(value).toMatchObject({ inspectionVersion: 'omk-extraction-study-inspection/v2', modelCallsByThisCommand: 0,
      summary: { completed: 2 }, review: { reportVersion: 'omk-extraction-study-review/v2', status: 'blocked', blockers: ['completion_time_unverified'], reference: { goldReady: true } },
      analysis: { analysisVersion: 'omk-extraction-study-analysis/v2', studyStatus: 'blocked' },
      calibration: { calibrationVersion: 'omk-extraction-study-judge-calibration/v2', ready: false, reasons: ['completion_time_unverified'] } });
    expect(value.slots.every(slot => slot.finishedAt === null && slot.elapsedMs === null
      && slot.elapsedStatus === 'completion_time_unverified' && slot.completionTimeStatus === 'completion_time_unverified')).toBe(true);
    expect(value.analysis.overall.arms.every(arm => arm.groupErrorRate === null && arm.scopedMetrics.entities.f1 === null)).toBe(true);
    expect(value.review.slots.every(slot => slot.metrics.mentions.f1 === null)).toBe(true);
    expect(JSON.stringify(f.files.evidence(f.plan))).toBe(before); expect(f.effects).toHaveBeenCalledTimes(2);
  });

  it('keeps missing human evidence pending instead of promoting engineering success or zero cost', async () => {
    const f = await nativeStudyEvidenceFixture(root());
    vi.spyOn(studyHost, 'extractionStudyHostIdentity').mockImplementation(f.ports.identity);
    const value = inspectExtractionStudy({ evidence: f.evidence });
    expect(value).toMatchObject({ summary: { completed: 2, totalCostUSD: null }, calibration: null,
      review: { status: 'pending', reference: { goldReady: false }, outputReview: { independentHuman: false } } });
    expect(value.review.missingTargets.length).toBeGreaterThan(0);
    expect(value.analysis.overall.arms.every(arm => arm.scopedMetrics.entities.precision === null)).toBe(true);
    const agent = inspectExtractionStudy({ evidence: f.evidence, judgeReceipt: f.judgeReceipt });
    expect(agent.review.status).toBe('pending'); expect(agent.review.outputReview.reviewed).toBe(0); expect(agent.review.reference.goldReady).toBe(false);
    expect(agent.judgeReview!.outputReview.judgeIdentity).toMatchObject({ executorRevision: 'authored-executor-r1', modelRevision: 'authored-model-r1' });
    expect(agent.judgeReview!.outputReview.independentHuman).toBe(false); expect(agent.judgeReview!.status).toBe('exploratory_reviewed');
    expect(agent.judgeReview!.decisions).toHaveLength(f.judgeReceipt.decisions.length);
    expect(agent.calibration).toMatchObject({ ready: false, status: 'pending' });
    expect(() => inspectExtractionStudy({ evidence: f.evidence, judgeReceipt: f.outputReceipt })).toThrow('knowledge_study_evidence_invalid');
  });

  it('preserves unknown started reservations, absent slots and unfinished wall-clock duration without dispatch', async () => {
    const f = nativeStudyFixture(root()), plan = f.prepare(); f.files.create(plan, f.corpusRaw, f.configurationRaw);
    const create = f.ports.runs.create.bind(f.ports.runs);
    const interrupted = vi.spyOn(f.ports.runs, 'create').mockImplementationOnce(run => { create(run); throw new Error('authored lost reservation acknowledgement'); });
    await expect(f.archiveSlot(plan, plan.slots[0].slotId)).rejects.toThrow('lost reservation');
    interrupted.mockRestore(); vi.spyOn(studyHost, 'extractionStudyHostIdentity').mockImplementation(f.ports.identity);
    const value = inspectExtractionStudy({ evidence: f.files.evidence(plan) });
    expect(value.summary).toMatchObject({ planned: 2, incomplete: 1, unattempted: 1, totalCostUSD: null });
    expect(value.slots).toMatchObject([{ status: 'generating', nativeVerified: false, finishedAt: null, elapsedMs: null, elapsedStatus: 'unfinished' },
      { status: 'unattempted', runId: null, elapsedMs: null, elapsedStatus: 'unattempted' }]);
    expect(value.review.status).toBe('blocked'); expect(f.effects).not.toHaveBeenCalled();
  });

  it('rejects caller trust flags before inspecting the fixed host and enforces total UTF-8 request capacity', () => {
    const fixedHost = vi.spyOn(studyHost, 'extractionStudyHostIdentity');
    for (const field of ['host', 'expectedHost', 'integrity', 'status', 'nativeVerified', 'goldReady', 'now', 'workspace']) {
      expect(() => inspectExtractionStudy({ evidence: {}, [field]: true })).toThrow('knowledge_study_input_invalid');
    }
    expect(fixedHost).not.toHaveBeenCalled();
    // Exercise the pre-host limit without allocating a 128 MiB fixture in every test worker.
    vi.spyOn(Buffer, 'byteLength').mockReturnValueOnce(EXTRACTION_STUDY_INSPECTION_MAX_BYTES + 1);
    expect(() => inspectExtractionStudy({ evidence: { description: '中文 UTF-8' } })).toThrow('knowledge_study_capacity_exceeded');
    expect(fixedHost).not.toHaveBeenCalled();
  });

  it('refuses substituted host, native bytes, birth content and review bindings with bounded static diagnostics', async () => {
    const f = await nativeStudyEvidenceFixture(root(), { annotated: true });
    const fixedHost = vi.spyOn(studyHost, 'extractionStudyHostIdentity').mockImplementation(f.ports.identity);
    const mutations = [
      (evidence: typeof f.evidence) => { evidence.records[0].outcomes[0].raw += ' '; },
      (evidence: typeof f.evidence) => { const run = JSON.parse(evidence.records[0].raw); run.intents[0].revision.content.statements[0].relation = 'PRIVATE-UNSUPPORTED-RELATION'; evidence.records[0].raw = JSON.stringify(run); },
      (evidence: typeof f.evidence) => { evidence.records[0].raw = '/private/PRIVATE-MALFORMED-NATIVE-JSON'; },
    ];
    for (const mutate of mutations) {
      const evidence = structuredClone(f.evidence); mutate(evidence);
      expect(() => inspectExtractionStudy({ evidence })).toThrow('knowledge_study_evidence_invalid');
    }
    expect(() => inspectExtractionStudy({ evidence: f.evidence, outputReceipt: { ...f.outputReceipt, outputDigest: extractionStudyDigest('different output') } })).toThrow('knowledge_study_evidence_invalid');
    fixedHost.mockImplementation(() => ({ ...f.ports.identity(), runtimeDigest: extractionStudyDigest('different runtime') }));
    let failure: unknown;
    try { inspectExtractionStudy({ evidence: f.evidence }); } catch (cause) { failure = cause; }
    expect(failure).toBeInstanceOf(ExtractionStudyInspectionError); expect(failure).toMatchObject({ code: 'knowledge_study_host_mismatch', message: 'knowledge_study_host_mismatch' });
    expect(String(failure)).not.toContain(f.root); expect(f.effects).toHaveBeenCalledTimes(2);
  });
});
