import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { ExtractionAttemptSchema } from '../../src/knowledge/extraction/runs.js';
import { configuredExtractionModel } from '../../src/knowledge/adapters/executor.js';
import { FROZEN_TYPED_GENERATION_UNSUPPORTED } from '../../src/knowledge/application/study-local.js';
import { createCodexArchiveProducer } from '../../src/executors/openai/codex/archive.js';
import { createOpenAiArchiveProducer } from '../../src/executors/openai/archive.js';
import { STRICT_EXTRACTION_PROMPT } from '../../src/knowledge/extraction/strict-prompt.js';
import { ENTITY_ONLY_EXTRACTION_PROFILE } from '../../src/knowledge/extraction/entity-only-prompt.js';
import { OCCURRENCE_GUIDED_EXTRACTION_PROFILE } from '../../src/knowledge/extraction/occurrence-guided-prompt.js';
import { WINDOW_EXTRACTION_WIRE_ID } from '../../src/knowledge/extraction/model-wire.js';
import { buildEntityTaskOnlyAblation, type EntityTaskOnlyAblationManifest } from '../../scripts/bench/assets/entity-task-only-ablation-v1/profile.js';
import { buildEntityEvidenceSemantics, type EntityEvidenceSemanticsManifest } from '../../scripts/bench/assets/entity-evidence-semantics-v1/profile.js';
import { captureTraceFixture } from '../helpers/knowledge-source.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function setup(reply?: (index: number, output: string) => ExecResult) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-runner-'))); roots.push(root);
  return nativeStudyFixture(root, reply);
}
function taskAblation() {
  const asset = new URL('../../scripts/bench/assets/entity-task-only-ablation-v1/', import.meta.url);
  const manifest: EntityTaskOnlyAblationManifest = JSON.parse(readFileSync(new URL('manifest.json', asset), 'utf8'));
  const suffix = readFileSync(new URL('task-suffix.txt', asset), 'utf8');
  return { baselineSystem: STRICT_EXTRACTION_PROMPT, suffix, wireId: WINDOW_EXTRACTION_WIRE_ID, manifest };
}

function evidenceSemantics() {
  const asset = new URL('../../scripts/bench/assets/entity-evidence-semantics-v1/', import.meta.url);
  const manifest: EntityEvidenceSemanticsManifest = JSON.parse(readFileSync(new URL('manifest.json', asset), 'utf8'));
  const rules = readFileSync(new URL('rules.txt', asset), 'utf8');
  return { baselineSystem: STRICT_EXTRACTION_PROMPT, rules, wireId: WINDOW_EXTRACTION_WIRE_ID, manifest };
}

describe('frozen extraction study archives (synthetic executor, zero model access)', () => {
  it('refuses historical study capture when Source3 is published after its outer preflight and before acquiring the write locks', () => {
    const f = setup(), root = join(f.workspace, 'sources'), sourcePath = join(f.root, 'source.jsonl');
    rmSync(root, { recursive: true }); mkdirSync(root);
    const capture = TraceEvidenceStore.prototype.capture;
    let published: { path: string; bytes: Buffer } | undefined;
    const interleave = vi.spyOn(TraceEvidenceStore.prototype, 'capture').mockImplementationOnce(function (this: TraceEvidenceStore, selection, signal) {
      // The caller has already passed its empty-directory preflight. Another writer now
      // completes a genuine Source3 publication using the same workspace/source locks.
      const source = captureTraceFixture(f.workspace, { path: sourcePath }), path = join(root, `${source.snapshotId}.json`);
      published = { path, bytes: readFileSync(path) };
      return capture.call(this, selection, signal);
    });
    try { expect(() => f.ports.application.capture({ path: sourcePath })).toThrow('knowledge_storage_unsupported'); }
    finally { interleave.mockRestore(); }
    expect(published).toBeDefined();
    expect(readdirSync(root)).toEqual([published!.path.slice(root.length + 1)]);
    expect(readFileSync(published!.path)).toEqual(published!.bytes); expect(f.effects).not.toHaveBeenCalled();
  });
  it.each(['snapshot', 'deleted snapshot'] as const)('refuses historical study capture into a Source3 workspace containing a %s without changing it', state => {
    const f = setup(), root = join(f.workspace, 'sources');
    rmSync(root, { recursive: true });
    const source = captureTraceFixture(f.workspace, { path: join(f.root, 'source.jsonl') });
    if (state === 'deleted snapshot') new FileSourceStore(root, f.workspace).delete(source.snapshotId, source.sourceVersion);
    const path = join(root, `${source.snapshotId}.json`), original = readFileSync(path), names = readdirSync(root);
    expect(() => f.ports.application.capture({ path: join(f.root, 'source.jsonl') })).toThrow('knowledge_storage_unsupported');
    expect(readFileSync(path)).toEqual(original); expect(readdirSync(root)).toEqual(names); expect(f.effects).not.toHaveBeenCalled();
  });
  it.each(['in_progress', 'complete', 'dangling marker'] as const)('refuses historical study capture for a %s migration marker', state => {
    const f = setup(), path = join(f.workspace, '.source-migration.json'), root = join(f.workspace, 'sources'), names = readdirSync(root);
    if (state === 'dangling marker') symlinkSync(join(f.root, 'missing-marker'), path);
    else writeFileSync(path, JSON.stringify({ state }));
    expect(() => f.ports.application.capture({ path: join(f.root, 'source.jsonl') })).toThrow('knowledge_storage_unsupported');
    expect(readdirSync(root)).toEqual(names); expect(f.effects).not.toHaveBeenCalled();
  });
  it('keeps independent Source2 study capture available with exact old deletion markers and atomic remnants', () => {
    const f = setup(), root = join(f.workspace, 'sources'), old = f.corpus.cases[0].window, path = join(root, `${old.snapshotId}.json`);
    writeFileSync(path, JSON.stringify({ snapshotId: old.snapshotId, deleted: true }));
    const remnant = join(root, `${old.snapshotId}.json.123.00000000-0000-4000-8000-000000000000.tmp`);
    writeFileSync(remnant, 'unfinished publication retained by the writer');
    const next = f.ports.application.capture({ path: join(f.root, 'source.jsonl') });
    expect(next.projectionVersion).toBe('knowledge-window-v2'); expect(f.ports.application.source(next.snapshotId, next.sourceVersion).status).toBe('available');
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify({ snapshotId: old.snapshotId, deleted: true }));
    expect(readFileSync(remnant, 'utf8')).toBe('unfinished publication retained by the writer'); expect(f.effects).not.toHaveBeenCalled();
  });
  it.each(['extended deletion marker', 'unexpected entry', 'symlink', 'oversized remnant'] as const)('refuses historical study capture with an %s before writing', state => {
    const f = setup(), root = join(f.workspace, 'sources'), old = f.corpus.cases[0].window;
    if (state === 'extended deletion marker') writeFileSync(join(root, `${old.snapshotId}.json`), JSON.stringify({ snapshotId: old.snapshotId, deleted: true, unsupported: true }));
    else if (state === 'unexpected entry') writeFileSync(join(root, 'unrecognized.json'), '{}');
    else if (state === 'symlink') symlinkSync(join(root, `${old.snapshotId}.json`), join(root, '00000000-0000-4000-8000-000000000000.json'));
    else writeFileSync(join(root, `${old.snapshotId}.json.123.00000000-0000-4000-8000-000000000000.tmp`), Buffer.alloc(16 * 1024 * 1024 + 257));
    const names = readdirSync(root);
    expect(() => f.ports.application.capture({ path: join(f.root, 'source.jsonl') })).toThrow('knowledge_storage_unsupported');
    expect(readdirSync(root)).toEqual(names); expect(f.effects).not.toHaveBeenCalled();
  });
  it.each(['baseline', 'candidate'] as const)('rejects a guided %s before inspecting or reserving a shared-input study', selected => {
    const f = setup(), baseline = f.model(), candidate = f.model();
    const baselineInspect = vi.spyOn(baseline, 'inspect'), candidateInspect = vi.spyOn(candidate, 'inspect');
    const create = vi.spyOn(f.ports.runs, 'create');
    expect(() => f.prepare({ changedVariable: 'prompt', variants: [
      { variantId: 'baseline', model: baseline, policy: SINGLE_EXTRACTION_POLICY,
        promptProfile: selected === 'baseline' ? OCCURRENCE_GUIDED_EXTRACTION_PROFILE : ENTITY_ONLY_EXTRACTION_PROFILE },
      { variantId: 'candidate', model: candidate, policy: SINGLE_EXTRACTION_POLICY,
        promptProfile: selected === 'candidate' ? OCCURRENCE_GUIDED_EXTRACTION_PROFILE : ENTITY_ONLY_EXTRACTION_PROFILE },
    ] })).toThrow(/shared.*input|input.*shared/i);
    expect(baselineInspect).not.toHaveBeenCalled(); expect(candidateInspect).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled(); expect(f.effects).not.toHaveBeenCalled(); expect(f.ports.runs.listManifests()).toEqual([]);
  });

  it('rejects a restored, internally byte-consistent guided plan at report, replay and run boundaries', async () => {
    const f = setup(), plan = f.prepare(), model = f.model();
    // Authored legacy-plan state: its digests and native request proof are real, but v1's shared source-only input is incompatible with v37.
    for (const variant of plan.variants) variant.promptProfile = { ...OCCURRENCE_GUIDED_EXTRACTION_PROFILE };
    for (const slot of plan.slots) {
      const sample = plan.cases.find(value => value.caseId === slot.caseId)!, variant = plan.variants.find(value => value.variantId === slot.variantId)!;
      slot.request.systemDigest = hash(variant.promptProfile.system);
      slot.producer = ExtractionAttemptSchema.shape.producer.parse(model.inspect!(variant.promptProfile.system, sample.input));
      slot.requestDigest = f.ports.hash({ snapshotId: sample.snapshotId, sourceVersion: sample.sourceVersion,
        executor: variant.executor, model: variant.model, promptHash: f.ports.hash(variant.promptProfile.system),
        inputDigest: f.ports.hash(sample.input), actor: plan.actor, policy: variant.policy, outputMode: variant.outputMode,
        wireId: variant.wireId, timeoutMs: variant.timeoutMs, maxOutputTokens: variant.maxOutputTokens });
    }
    const { planId: originalPlanId, ...body } = plan;
    plan.planId = extractionStudyDigest(body); expect(plan.planId).not.toBe(originalPlanId);
    const restored = parseExtractionStudyPlan(plan);
    f.files.create(restored, f.corpusRaw, f.configurationRaw);
    const evidence = f.files.evidence(restored), create = vi.spyOn(f.ports.runs, 'create');
    const actualModel = vi.spyOn(f.ports, 'model'), generate = vi.spyOn(f.ports.application, 'generate');
    expect(() => reportExtractionStudy(f.ports, restored, f.corpus)).toThrow(/shared.*input|input.*shared/i);
    expect(() => replayExtractionStudyEvidence(evidence)).toThrow(/shared.*input|input.*shared/i);
    await expect(runExtractionStudySlot(f.ports, { plan: restored, corpus: f.corpus, slotId: restored.slots[0].slotId }))
      .rejects.toThrow(/shared.*input|input.*shared/i);
    expect(actualModel).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(f.effects).not.toHaveBeenCalled(); expect(f.ports.runs.listManifests()).toEqual([]);
  });

  it('freezes paired order and replays synthetic byte-bound archives without current product generation', async () => {
    const f = setup((_index, output) => native(output, { attemptCount: 2 })), plan = f.prepare({ repeats: 2 });
    f.files.create(plan, f.corpusRaw, f.configurationRaw);
    expect(f.effects).not.toHaveBeenCalled(); expect(plan.slots.map(value => value.variantId)).toEqual(['baseline', 'candidate', 'candidate', 'baseline']);
    const initial = reportExtractionStudy(f.ports, plan, f.corpus);
    expect(initial.summary).toMatchObject({ planned: 4, unattempted: 4, totalCostUSD: null, executorReportedAttempts: null });
    await expect(runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[1].slotId })).rejects.toThrow('predeclared order');
    for (const slot of plan.slots) await f.archiveSlot(plan, slot.slotId);
    expect(f.effects).toHaveBeenCalledTimes(4);
    const report = replayExtractionStudyEvidence(f.files.evidence(plan), f.ports.identity());
    expect(report.summary).toMatchObject({ completed: 4, unattempted: 0, attempts: 4, executorReportedAttempts: 8, recordedNative: 4, totalCostUSD: null, totalInputTokens: 28 });
    expect(report.slots.every(value => value.nativeVerified && value.run?.intents.length === 1)).toBe(true);
    expect(report.goldReady).toBe(false); expect(report.qualityConclusion).toBe('not_evaluated');
    const bytes = plan.slots.map(slot => readFileSync(join(f.workspace, 'extraction-runs', `${slot.runId}.json`)));
    replayExtractionStudyEvidence(f.files.evidence(plan), f.ports.identity());
    expect(f.effects).toHaveBeenCalledTimes(4);
    expect(plan.slots.map(slot => readFileSync(join(f.workspace, 'extraction-runs', `${slot.runId}.json`)))).toEqual(bytes);
    expect(replayExtractionStudyEvidence(f.files.evidence(plan)).integrity.outputVerified).toBe(false);
  });
  it('refuses default frozen typed generation without invoking or claiming either policy', async () => {
    const f = setup();
    const bounded = boundedExtractionPolicy({ maxInvocations: 2, maxReasks: 1, maxTotalTokens: 2176, maxOutputTokens: 64, profileId: 'loopback-test/v1' });
    for (const policy of [SINGLE_EXTRACTION_POLICY, bounded]) {
      const plan = f.prepare({ variants: [{ variantId: 'baseline', model: f.model(), policy }, { variantId: 'candidate', model: f.model(), policy }] });
      await expect(runExtractionStudySlot(f.ports, { plan, corpus: f.corpus, slotId: plan.slots[0].slotId }))
        .rejects.toThrow(FROZEN_TYPED_GENERATION_UNSUPPORTED);
    }
    expect(f.effects).not.toHaveBeenCalled(); expect(f.ports.runs.listManifests()).toEqual([]);
  });
  it('preserves malformed authored output and request proof tamper detection in read-only replay', async () => {
    const f = setup((index, output) => native(index ? output : '{')), plan = f.prepare();
    f.files.create(plan, f.corpusRaw, f.configurationRaw);
    for (const slot of plan.slots) await f.archiveSlot(plan, slot.slotId);
    const evidence = f.files.evidence(plan), report = replayExtractionStudyEvidence(evidence, f.ports.identity());
    expect(report.summary).toMatchObject({ failed: 1, completed: 1, attempts: 2, recordedNative: 2, totalCostUSD: null });
    expect(report.slots[0].attempts[0].outcome).toMatchObject({ outcomeKind: 'result', result: { output: '{' } });
    for (const field of ['bodyDigest', 'endpoint', 'redirect', 'singleCompletion']) {
      const changed = structuredClone(evidence), run = JSON.parse(changed.records[1].raw), attempt = run.attempts[0];
      attempt.producer.proof[field] = 'synthetic drift';
      attempt.requestDigest = extractionStudyDigest({ requestDigest: run.requestDigest, request: attempt.request, producer: attempt.producer, policy: run.policy });
      changed.records[1].raw = JSON.stringify(run);
      expect(() => replayExtractionStudyEvidence(changed, f.ports.identity())).toThrow(/request differs|producer|frozen/);
    }
    expect(f.effects).toHaveBeenCalledTimes(2);
  });
  it('keeps a synthetic lost reservation acknowledgement visible without recovery or redispatch', async () => {
    const f = setup(), plan = f.prepare(); f.files.create(plan, f.corpusRaw, f.configurationRaw);
    const create = f.ports.runs.create.bind(f.ports.runs);
    const reservation = vi.spyOn(f.ports.runs, 'create').mockImplementationOnce(run => { create(run); throw new Error('authored lost reservation acknowledgement'); });
    await expect(f.archiveSlot(plan, plan.slots[0].slotId)).rejects.toThrow('lost reservation'); reservation.mockRestore();
    const bytes = readFileSync(join(f.workspace, 'extraction-runs', `${plan.slots[0].runId}.json`));
    const report = replayExtractionStudyEvidence(f.files.evidence(plan), f.ports.identity());
    expect(report.summary).toMatchObject({ incomplete: 1, unattempted: 1, attempts: 1, recordedNative: 0, totalCostUSD: null });
    expect(readFileSync(join(f.workspace, 'extraction-runs', `${plan.slots[0].runId}.json`))).toEqual(bytes);
    expect(f.effects).not.toHaveBeenCalled();
  });
  it('rejects portable native tampering, birth rewriting and runtime drift before semantic review', async () => {
    const f = setup(), plan = f.prepare(); f.files.create(plan, f.corpusRaw, f.configurationRaw);
    await f.archiveSlot(plan, plan.slots[0].slotId);
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
  it('keeps the entity-task asset byte-bound and rejects drift without discovering a model or source', () => {
    const input = taskAblation(), profiles = buildEntityTaskOnlyAblation(input);
    expect(input.manifest.baseline.systemDigest).toBe('sha256:45ccb3821a6ec2c0ee1bc5f8f6ab4f2e3590724e2d4453cd39d77f46d4fb0085');
    expect(input.manifest.candidate.systemDigest).toBe('sha256:d282562d720653a31894190e4102dda57125ddcd7d8d5fc2e9196c1c5301a53e');
    expect(profiles.baseline.system).toBe(STRICT_EXTRACTION_PROMPT);
    expect(profiles.candidate.system).toBe(STRICT_EXTRACTION_PROMPT + input.suffix);
    for (const changed of [
      { ...input, baselineSystem: input.baselineSystem + '\n' },
      { ...input, suffix: input.suffix.trim() },
      { ...input, wireId: hash('different wire') },
      { ...input, manifest: { ...input.manifest, candidate: { ...input.manifest.candidate, promptVersion: 'knowledge-extraction-v30' } } },
      { ...input, manifest: { ...input.manifest, candidate: { ...input.manifest.candidate, systemDigest: hash('different candidate') } } },
    ]) expect(() => buildEntityTaskOnlyAblation(changed)).toThrow(/frozen/);
  });
  it('freezes the joint-task evidence rules independently of the task-only experiment', () => {
    const input = evidenceSemantics(), profiles = buildEntityEvidenceSemantics(input);
    expect(input.manifest.baseline.systemDigest).toBe('sha256:45ccb3821a6ec2c0ee1bc5f8f6ab4f2e3590724e2d4453cd39d77f46d4fb0085');
    expect(input.manifest.rules.digest).toBe('sha256:d13d6a3d92ff3698c103851a32efd4fe60a14566f6ae13652f1d23c9fc3a7b4a');
    expect(input.manifest.candidate.systemDigest).toBe('sha256:670b31774d288d0fa03687d7e87ffcaf2721dccbd914e484b43cc8e3701a3ac9');
    expect(profiles.baseline.system).toBe(STRICT_EXTRACTION_PROMPT);
    expect(profiles.candidate.system).toBe(STRICT_EXTRACTION_PROMPT + input.rules);
    expect(profiles.candidate.promptVersion).toBe('knowledge-extraction-v34');
    for (const changed of [
      { ...input, baselineSystem: input.baselineSystem + '\n' },
      { ...input, rules: input.rules.trim() },
      { ...input, wireId: hash('other wire') },
      { ...input, manifest: { ...input.manifest, candidate: { ...input.manifest.candidate, promptVersion: 'knowledge-extraction-v33' } } },
      { ...input, manifest: { ...input.manifest, candidate: { ...input.manifest.candidate, systemDigest: hash('other rules') } } },
    ]) expect(() => buildEntityEvidenceSemantics(changed)).toThrow(/frozen/);
  });
  it.each([
    { task: 'entity-only', profiles: () => buildEntityTaskOnlyAblation(taskAblation()), version: 'knowledge-extraction-v33', knowledge: false },
    { task: 'joint evidence semantics', profiles: () => buildEntityEvidenceSemantics(evidenceSemantics()), version: 'knowledge-extraction-v34', knowledge: true },
  ])('dispatches frozen $task bytes and preserves the complete native result and births', async entry => {
    const profiles = entry.profiles();
    const f = setup((index, output) => {
      if (index === 0 || entry.knowledge) return native(output);
      const response = JSON.parse(output); response.proposals = [];
      return native(JSON.stringify(response));
    });
    const plan = f.prepare({ changedVariable: 'prompt', variants: [
      { variantId: 'baseline', model: f.model(), policy: SINGLE_EXTRACTION_POLICY, promptProfile: profiles.baseline },
      { variantId: 'candidate', model: f.model(), policy: SINGLE_EXTRACTION_POLICY,
        promptProfile: profiles.candidate },
    ] });
    f.files.create(plan, f.corpusRaw, f.configurationRaw);
    for (const slot of plan.slots) await f.archiveSlot(plan, slot.slotId);
    for (const [index, profile] of [profiles.baseline, profiles.candidate].entries()) {
      expect(f.effects).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({ system: profile.system, prompt: plan.cases[0].input }));
      expect(plan.slots[index].request.systemDigest).toBe(hash(profile.system));
    }
    const report = replayExtractionStudyEvidence(f.files.evidence(plan), f.ports.identity());
    expect(report.slots[0].run?.promptHash).not.toBe(report.slots[1].run?.promptHash);
    expect(report.slots[1].run?.promptVersion).toBe(entry.version);
    expect(report.slots[0].run?.policy).toEqual(report.slots[1].run?.policy);
    const candidate = report.slots[1].run!;
    expect(candidate.status).toBe('completed');
    expect(candidate.intents).toHaveLength(entry.knowledge ? 1 : 0);
    expect(candidate.committed).toHaveLength(entry.knowledge ? 1 : 0);
    expect(candidate.entityRejections).toEqual([]); expect(candidate.rejections).toEqual([]);
    expect(candidate.entityAnalysis?.revision.entities.map(entity => entity.label)).toEqual(['Alpha', 'Beta']);
    expect(candidate.entityAnalysis?.revision.mentions).toHaveLength(2);
    // The frozen archive contains a fictional typed birth; no current KnowledgeStore/entity store is written.
    expect(candidate.entityAnalysis?.revision.revisionId).toBeDefined();
    const candidateNative = report.slots[1].attempts[0].outcome;
    expect(candidateNative?.outcomeKind).toBe('result');
    if (candidateNative?.outcomeKind !== 'result') throw new Error('Authored native result is missing.');
    expect(JSON.parse(candidateNative.result.output as string).proposals).toHaveLength(entry.knowledge ? 1 : 0);
    expect(candidate.rawOutput).toBe(candidateNative.result.output);
    replayExtractionStudyEvidence(f.files.evidence(plan), f.ports.identity());
    expect(f.effects).toHaveBeenCalledTimes(2);
    expect(report.goldReady).toBe(false); expect(report.qualityConclusion).toBe('not_evaluated');
  });
  it('keeps the policy contrast separate from prompt variation without configuring an executor', () => {
    const f = setup();
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
    expect(create).not.toHaveBeenCalled(); expect(f.effects).not.toHaveBeenCalled();
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
