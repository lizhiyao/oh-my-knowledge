import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportExtractionStudy, replayExtractionStudyEvidence, runExtractionStudySlot } from '../../src/knowledge/application/study-runner.js';
import { ExtractionStudyFiles } from '../../src/knowledge/adapters/study-files.js';
import type { ExecResult } from '../../src/executors/contracts/result.js';
import { extractionStudyDigest } from '../../src/knowledge/extraction/study-corpus.js';
import { boundedExtractionPolicy, SINGLE_EXTRACTION_POLICY } from '../../src/knowledge/extraction/generation-policy.js';
import { nativeStudyFixture, studyNativeResult as native } from './extraction-study-fixtures.js';
import { parseKnowledgeStudyArguments } from '../../scripts/bench/knowledge-study.js';
import { parseExtractionStudyPlan } from '../../src/knowledge/extraction/study-plan.js';
import { configuredExtractionModel } from '../../src/knowledge/adapters/executor.js';
import { createCodexArchiveProducer } from '../../src/executors/openai/codex/archive.js';
import { createOpenAiArchiveProducer } from '../../src/executors/openai/archive.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function setup(reply?: (index: number, output: string) => ExecResult) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-runner-'))); roots.push(root);
  return nativeStudyFixture(root, reply);
}

describe('production extraction study runner (authored executor, zero model access)', () => {
  it('freezes complete paired order before effects, advances production births and replays byte-bound evidence without dispatch', async () => {
    const f = setup((_index, output) => native(output, { attemptCount: 2 })), plan = f.prepare({ repeats: 2 });
    f.files.create(plan, f.corpusRaw, f.configurationRaw);
    expect(f.effects).not.toHaveBeenCalled(); expect(plan.slots.map(value => value.variantId)).toEqual(['baseline', 'candidate', 'candidate', 'baseline']);
    const initial = reportExtractionStudy(f.ports, plan, f.corpus);
    expect(initial.summary).toMatchObject({ planned: 4, unattempted: 4, totalCostUSD: null, executorReportedAttempts: null });
    await expect(runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[1].slotId })).rejects.toThrow('predeclared order');
    for (const slot of plan.slots) await runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: slot.slotId });
    expect(f.effects).toHaveBeenCalledTimes(4);
    const report = replayExtractionStudyEvidence(f.files.evidence(plan), f.ports.identity());
    expect(report.summary).toMatchObject({ completed: 4, unattempted: 0, attempts: 4, executorReportedAttempts: 8, recordedNative: 4, totalCostUSD: null, totalInputTokens: 28 });
    expect(report.slots.every(value => value.nativeVerified && value.run?.intents.length === 1)).toBe(true);
    expect(report.goldReady).toBe(false); expect(report.qualityConclusion).toBe('not_evaluated');
    const bytes = plan.slots.map(slot => readFileSync(join(f.workspace, 'extraction-runs', `${slot.runId}.json`)));
    await runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[0].slotId });
    expect(f.effects).toHaveBeenCalledTimes(4);
    expect(plan.slots.map(slot => readFileSync(join(f.workspace, 'extraction-runs', `${slot.runId}.json`)))).toEqual(bytes);
    expect(replayExtractionStudyEvidence(f.files.evidence(plan)).integrity.outputVerified).toBe(false);
  });
  it('recovers a lost archive observer from production evidence and counts all retries, including unknown cost', async () => {
    const f = setup((index, output) => native(index ? output : '{')), selected = boundedExtractionPolicy({
      maxInvocations: 2, maxReasks: 1, maxTotalTokens: 2176, maxOutputTokens: 64, profileId: 'loopback-test/v1' });
    const plan = f.prepare({ variants: [{ variantId: 'baseline', model: f.model(), policy: selected }, { variantId: 'candidate', model: f.model(), policy: selected }] });
    f.files.create(plan, f.corpusRaw, f.configurationRaw);
    await expect(runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[0].slotId,
      onOutcomeArchived() { throw new Error('authored observer lost acknowledgement'); } })).rejects.toThrow('observer lost');
    expect(f.effects).toHaveBeenCalledTimes(1);
    expect(reportExtractionStudy(f.ports, plan, f.corpus).summary).toMatchObject({ incomplete: 1, generating: 1, archivePending: 0 });
    const resumed = await runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[0].slotId });
    expect(resumed.slots[0].run?.status).toBe('failed'); expect(f.effects).toHaveBeenCalledTimes(1);
    await runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[1].slotId });
    const report = replayExtractionStudyEvidence(f.files.evidence(plan), f.ports.identity());
    expect(report.summary).toMatchObject({ failed: 1, completed: 1, attempts: 2, totalCostUSD: null });
    expect(report.slots[0].attempts[0].outcome).toMatchObject({ outcomeKind: 'result', result: { output: '{' } });
  });
  it('preserves failed attempts before a production reask and derives every native accounting record', async () => {
    const f = setup((index, output) => native(index % 2 ? output : '{'));
    const selected = boundedExtractionPolicy({ maxInvocations: 2, maxReasks: 1, maxTotalTokens: 2176, maxOutputTokens: 64, profileId: 'loopback-test/v1' });
    const plan = f.prepare({ variants: [{ variantId: 'baseline', model: f.model(), policy: selected }, { variantId: 'candidate', model: f.model(), policy: selected }] });
    f.files.create(plan, f.corpusRaw, f.configurationRaw);
    for (const slot of plan.slots) await runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: slot.slotId });
    const report = replayExtractionStudyEvidence(f.files.evidence(plan), f.ports.identity());
    expect(f.effects).toHaveBeenCalledTimes(4); expect(report.summary).toMatchObject({ completed: 2, attempts: 4, recordedNative: 4, totalInputTokens: 28, totalCostUSD: null });
    expect(report.slots.every(slot => slot.run?.attempts[0].failure?.failureKind === 'parse_error')).toBe(true);
    const changed = structuredClone(f.files.evidence(plan));
    const run = JSON.parse(changed.records[0].raw); run.attempts[0].accounting.costUSD = 2; changed.records[0].raw = JSON.stringify(run);
    expect(() => replayExtractionStudyEvidence(changed, f.ports.identity())).toThrow('accounting differs');
    type MutableProducer = { proof: Record<string, unknown>; maxOutcomeJsonBytes: number; sourceChannels: { maxBytes: number }[] };
    const producerChanges = [
      (producer: MutableProducer) => { producer.proof.bodyDigest = hash('different retry body'); },
      (producer: MutableProducer) => { producer.proof.endpoint = 'http://127.0.0.1:2/v1/chat/completions'; },
      (producer: MutableProducer) => { producer.proof.redirect = 'follow'; },
      (producer: MutableProducer) => { producer.proof.singleCompletion = false; },
      (producer: MutableProducer) => { producer.maxOutcomeJsonBytes++; },
      (producer: MutableProducer) => { producer.sourceChannels[0].maxBytes++; },
    ];
    for (const change of producerChanges) {
      const tampered = structuredClone(f.files.evidence(plan)), rewritten = JSON.parse(tampered.records[0].raw);
      const retry = rewritten.attempts[1]; change(retry.producer);
      // Recomputing a receipt cannot make changed transport conditions or unrelated body bytes valid.
      retry.requestDigest = extractionStudyDigest({ requestDigest: rewritten.requestDigest, request: retry.request,
        producer: retry.producer, policy: rewritten.policy, budget: retry.budget, trigger: retry.trigger ?? null });
      tampered.records[0].raw = JSON.stringify(rewritten);
      expect(() => replayExtractionStudyEvidence(tampered, f.ports.identity())).toThrow(/producer conditions changed|producer request body differs/);
    }
    expect(f.effects).toHaveBeenCalledTimes(4);
  });
  it('keeps unknown started reservations and prevents later paired slots or replay from redispatching them', async () => {
    const f = setup(), plan = f.prepare();
    f.files.create(plan, f.corpusRaw, f.configurationRaw);
    const create = f.ports.runs.create.bind(f.ports.runs);
    const reservation = vi.spyOn(f.ports.runs, 'create').mockImplementationOnce(run => { create(run); throw new Error('authored lost reservation acknowledgement'); });
    await expect(runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[0].slotId })).rejects.toThrow('lost reservation'); reservation.mockRestore();
    const report = await runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[0].slotId });
    expect(report.summary).toMatchObject({ incomplete: 1, unattempted: 1, attempts: 1, recordedNative: 0, totalCostUSD: null });
    await expect(runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[1].slotId })).rejects.toThrow('unknown or incomplete');
    expect(f.effects).not.toHaveBeenCalled();
  });
  it('rejects portable native tampering, birth rewriting and runtime drift before semantic review', async () => {
    const f = setup(), plan = f.prepare(); f.files.create(plan, f.corpusRaw, f.configurationRaw);
    await runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[0].slotId });
    const original = f.files.evidence(plan), nativeChanged = structuredClone(original);
    nativeChanged.records[0].outcomes[0].raw += ' ';
    expect(() => replayExtractionStudyEvidence(nativeChanged, f.ports.identity())).toThrow('digest mismatch');
    const birthChanged = structuredClone(original), run = JSON.parse(birthChanged.records[0].raw);
    run.intents[0].revision.content.statements[0].relation = 'new ungrounded relation'; birthChanged.records[0].raw = JSON.stringify(run);
    expect(() => replayExtractionStudyEvidence(birthChanged, f.ports.identity())).toThrow('knowledge birth differs');
    expect(() => replayExtractionStudyEvidence(original, { ...f.ports.identity(), runtimeDigest: hash('other runtime') })).toThrow('frozen runtime');
    const nativePath = join(f.workspace, 'extraction-runs', 'outcomes', plan.slots[0].runId, `${original.records[0].outcomes[0].attemptId}.json`);
    const nativeBytes = readFileSync(nativePath);
    writeFileSync(nativePath, Buffer.concat([nativeBytes, Buffer.from(' ')]));
    await expect(runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[1].slotId })).rejects.toThrow();
    expect(f.effects).toHaveBeenCalledTimes(1);
    rmSync(nativePath);
    await expect(runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[1].slotId })).rejects.toThrow();
    writeFileSync(nativePath, nativeBytes);
    expect(f.effects).toHaveBeenCalledTimes(1);
  });
  it('rejects multi-variable contrasts and oversized declarations without allocating slots or effects', () => {
    const f = setup();
    expect(() => f.prepare({ repeats: Number.MAX_SAFE_INTEGER })).toThrow('16 MiB');
    expect(() => f.prepare({ changedVariable: 'prompt' })).toThrow('distinct version');
    const candidate = { ...f.model(), model: 'different-model' };
    expect(() => f.prepare({ variants: [{ variantId: 'baseline', model: f.model(), policy: SINGLE_EXTRACTION_POLICY }, { variantId: 'candidate', model: candidate, policy: SINGLE_EXTRACTION_POLICY }] })).toThrow('declared variable');
    expect(f.effects).not.toHaveBeenCalled();
    const changed = structuredClone(f.prepare()); changed.slots[0].request.systemDigest = hash('other rules');
    const { planId: _oldId, ...body } = changed; void _oldId; changed.planId = extractionStudyDigest(body);
    expect(() => parseExtractionStudyPlan(changed)).toThrow('slot request identity');
    const rootChanged = structuredClone(f.prepare()); rootChanged.slots[0].requestDigest = hash('other request');
    const { planId: _oldRootId, ...rootBody } = rootChanged; void _oldRootId; rootChanged.planId = extractionStudyDigest(rootBody);
    expect(() => parseExtractionStudyPlan(rootChanged)).toThrow('slot request identity');
  });
  it('binds an explicit prompt-only candidate to the actual production dispatch and keeps a policy-only contrast separate', async () => {
    const f = setup(), plan = f.prepare({ changedVariable: 'prompt', variants: [
      { variantId: 'baseline', model: f.model(), policy: SINGLE_EXTRACTION_POLICY },
      { variantId: 'candidate', model: f.model(), policy: SINGLE_EXTRACTION_POLICY,
        promptProfile: { profileVersion: 'knowledge-extraction-prompt-profile/v1', promptVersion: 'knowledge-extraction-v9001', system: 'Authored candidate rules; exercise bytes only, no quality claim.' } },
    ] });
    f.files.create(plan, f.corpusRaw, f.configurationRaw);
    for (const slot of plan.slots) await runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: slot.slotId });
    const report = replayExtractionStudyEvidence(f.files.evidence(plan), f.ports.identity());
    expect(report.slots[0].run?.promptHash).not.toBe(report.slots[1].run?.promptHash);
    expect(report.slots[1].run?.promptVersion).toBe('knowledge-extraction-v9001');
    expect(report.slots[0].run?.policy).toEqual(report.slots[1].run?.policy);
    const create = vi.fn(() => { throw new Error('Preparation must not configure an executor.'); });
    const producer = createOpenAiArchiveProducer({ NODE_ENV: 'test', OPENAI_API_KEY: 'authored-test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1' }, create);
    const selected = boundedExtractionPolicy({ maxInvocations: 2, maxReasks: 1, maxTotalTokens: 2304, maxOutputTokens: 128, profileId: 'loopback-test/v1' });
    const policyPlan = f.prepare({ changedVariable: 'policy', variants: [
      { variantId: 'baseline', model: f.model(), policy: SINGLE_EXTRACTION_POLICY },
      { variantId: 'candidate', model: configuredExtractionModel('openai-api', 'authored-loopback-test', producer, { maxOutputTokens: 128 }), policy: selected },
    ] });
    expect(policyPlan.variants[0].promptProfile).toEqual(policyPlan.variants[1].promptProfile);
    expect(policyPlan.variants[0].policy).not.toEqual(policyPlan.variants[1].policy);
    expect(policyPlan.slots.map(slot => slot.request.maxOutputTokens)).toEqual([64, 128]);
    expect(policyPlan.slots[0].producer.proof).not.toEqual(policyPlan.slots[1].producer.proof);
    expect(create).not.toHaveBeenCalled(); expect(f.effects).toHaveBeenCalledTimes(2);
  });
  it('compares real Codex producers on a common request while preserving both actual prompt-dependent proofs without execution', () => {
    const f = setup(), create = vi.fn(() => { throw new Error('Preparation must not configure an executor.'); });
    const producer = createCodexArchiveProducer({ NODE_ENV: 'test', HOME: f.root }, create);
    const baseline = configuredExtractionModel('codex', 'authored-codex-test', producer);
    const candidate = configuredExtractionModel('codex', 'authored-codex-test', producer);
    const baselineProfile = { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const, promptVersion: 'knowledge-extraction-v9001', system: 'Authored baseline.' };
    const candidateProfile = { ...baselineProfile, promptVersion: 'knowledge-extraction-v9002', system: 'Authored longer candidate; no model quality claim.' };
    const plan = f.prepare({ changedVariable: 'prompt', variants: [
      { variantId: 'baseline', model: baseline, policy: SINGLE_EXTRACTION_POLICY, promptProfile: baselineProfile },
      { variantId: 'candidate', model: candidate, policy: SINGLE_EXTRACTION_POLICY, promptProfile: candidateProfile },
    ] });
    const [a, b] = plan.slots;
    expect(a.producer).toEqual(baseline.inspect!(baselineProfile.system, plan.cases[0].input));
    expect(b.producer).toEqual(candidate.inspect!(candidateProfile.system, plan.cases[0].input));
    const aProof = a.producer.proof as Record<string, unknown>, bProof = b.producer.proof as Record<string, unknown>;
    expect(aProof.requestDigest).not.toBe(bProof.requestDigest);
    expect(aProof.localContextBytes).not.toBe(bProof.localContextBytes);
    expect(a.producer.sourceChannels).not.toEqual(b.producer.sourceChannels);
    expect(a.producer.maxOutcomeJsonBytes).not.toBe(b.producer.maxOutcomeJsonBytes);
    expect(parseExtractionStudyPlan(plan)).toEqual(plan);
    expect(() => configuredExtractionModel('codex', 'authored-codex-test', producer, { maxOutputTokens: 128 })).toThrow('maxOutputTokens');
    expect(create).not.toHaveBeenCalled(); expect(f.effects).not.toHaveBeenCalled();
  });
  it.each(['environment', 'temporary-root'] as const)('rejects real Codex %s drift despite a common request without execution', difference => {
    const f = setup(), create = vi.fn(() => { throw new Error('Preparation must not configure an executor.'); });
    const environment = { NODE_ENV: 'test', HOME: f.root, TMPDIR: join(f.root, 'authored-tmp') };
    const baseline = configuredExtractionModel('codex', 'authored-codex-test', createCodexArchiveProducer(environment, create));
    let candidate: ReturnType<typeof configuredExtractionModel>;
    try {
      if (difference === 'temporary-root') vi.stubEnv('TMPDIR', join(f.root, 'other-authored-tmp'));
      candidate = configuredExtractionModel('codex', 'authored-codex-test', createCodexArchiveProducer(
        difference === 'environment' ? { ...environment, TMPDIR: join(f.root, 'different-env-tmp') } : environment, create));
    } finally { vi.unstubAllEnvs(); }
    expect(() => f.prepare({ variants: [
      { variantId: 'baseline', model: baseline, policy: SINGLE_EXTRACTION_POLICY },
      { variantId: 'candidate', model: candidate, policy: SINGLE_EXTRACTION_POLICY },
    ] })).toThrow('producer conditions differ');
    expect(create).not.toHaveBeenCalled(); expect(f.effects).not.toHaveBeenCalled();
  });
  it('retains external raw bytes and refuses overwrite, symlink or workspace output destinations', () => {
    const f = setup(), plan = f.prepare(); f.files.create(plan, f.corpusRaw, f.configurationRaw);
    expect(f.files.open().corpusText).toBe(f.corpusRaw);
    expect(() => f.files.create(plan, f.corpusRaw, f.configurationRaw)).toThrow();
    expect(() => new ExtractionStudyFiles({ directory: join(f.workspace, 'bad'), workspace: f.workspace, repository: resolve('.') })).toThrow('isolated');
    const link = join(f.root, 'link'); symlinkSync(f.files.directory, link);
    expect(() => new ExtractionStudyFiles({ directory: link, workspace: f.workspace, repository: resolve('.') })).toThrow('symlink');
    writeFileSync(join(f.files.directory, 'configuration.json'), '{"modified":true}');
    expect(() => f.files.open()).toThrow('configuration bytes changed');
  });
  it('parses explicit zero-call modes and requires an exact plan authorization flag for run', () => {
    expect(parseKnowledgeStudyArguments(['--help'])).toBeNull();
    expect(() => parseKnowledgeStudyArguments(['run', '--workspace', '/authored/workspace', '--study', '/authored/study', '--slot', 's'])).toThrow('Missing');
    expect(parseKnowledgeStudyArguments(['report', '--workspace', '/authored/workspace', '--study', '/authored/study', '--output', '/authored/report'])?.command).toBe('report');
    expect(() => parseKnowledgeStudyArguments(['report', '--workspace', '/x', '--workspace', '/y'])).toThrow('duplicate');
  });
});
