import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import { UserSettingsStore } from '../../src/evidence/storage/user-settings.js';
import * as studyHost from '../../src/knowledge/adapters/study-host.js';
import * as studyInspection from '../../src/knowledge/application/study-inspection.js';
import * as studyService from '../../src/knowledge/application/study-inspection-service.js';
import { ExtractionStudyInspectionError } from '../../src/knowledge/adapters/study-inspection-errors.js';
import { readExtractionStudyInspectionFiles } from '../../src/knowledge/adapters/study-inspection-input.js';
import { EXTRACTION_STUDY_INSPECTION_MAX_BYTES } from '../../src/knowledge/extraction/study-capacity.js';
import { nativeStudyEvidenceFixture, studyNativeResult } from '../knowledge/extraction-study-fixtures.js';
import { runCommand } from '../helpers/run-command.js';

// Command tests exercise the shared processor with authored hosts; built-worker tests cover real scheduling.
beforeEach(() => {
  vi.spyOn(studyService, 'inspectExtractionStudyFiles').mockImplementation(async files =>
    studyInspection.inspectExtractionStudy(readExtractionStudyInspectionFiles(files)));
});
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'omk-cli-study-'))); roots.push(path); return path;
}
function treeDigest(directory: string): string {
  const hash = createHash('sha256');
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const file = join(path, entry.name); hash.update(file.slice(directory.length));
      if (entry.isDirectory()) walk(file); else hash.update(readFileSync(file));
    }
  };
  walk(directory); return hash.digest('hex');
}
async function capturedFixture(annotated = false) {
  const directory = root(), f = await nativeStudyEvidenceFixture(directory, { annotated, reply: (_index, output) => ({
    ...studyNativeResult(output), authoredPrivateNative: 'PRIVATE-NATIVE-STUDY-SENTINEL',
  }) });
  const evidencePath = join(directory, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify(f.evidence));
  vi.spyOn(studyHost, 'extractionStudyHostIdentity').mockImplementation(f.ports.identity);
  const home = join(directory, 'home'); mkdirSync(home); writeFileSync(join(home, 'settings.json'), '{invalid'); vi.stubEnv('OMK_HOME', home);
  return { ...f, directory, evidencePath, home };
}

describe('observe knowledge study read-only wiring', () => {
  it('reads real archived authored evidence before settings resolution, keeps workspace bytes and emits a safe pending DTO', async () => {
    const f = await capturedFixture(), original = treeDigest(f.workspace), calls = f.effects.mock.calls.length;
    const settings = vi.spyOn(UserSettingsStore.prototype, 'resolve').mockImplementation(() => { throw new Error('Study must not resolve workspace settings.'); });
    const fetch = vi.fn(() => { throw new Error('Study must not call a model.'); }); vi.stubGlobal('fetch', fetch);
    const json = await runCommand(ObserveKnowledge, ['study', '--evidence', f.evidencePath, '--json', '--lang', 'en'], { cwd: f.directory });
    const dto = JSON.parse(json.stdout);
    expect(dto).toMatchObject({ inspectionVersion: 'omk-extraction-study-inspection/v1', modelCallsByThisCommand: 0,
      summary: { planned: 2, completed: 2, totalCostUSD: null }, review: { status: 'pending', reference: { goldReady: false } } });
    expect(json.stderr).toBe(''); expect(json.stdout).not.toContain('PRIVATE-NATIVE-STUDY-SENTINEL');
    expect(json.stdout).not.toContain('corpusRaw'); expect(json.stdout).not.toContain('sourcePath'); expect(json.stdout).not.toContain(f.directory);
    const zh = await runCommand(ObserveKnowledge, ['study', '--evidence', f.evidencePath, '--lang', 'zh'], { cwd: f.directory });
    expect(zh.stdout).toContain('本次模型调用 0'); expect(zh.stdout).toContain('待复核'); expect(zh.stdout).toContain('未知／未报告');
    const en = await runCommand(ObserveKnowledge, ['study', '--evidence', f.evidencePath, '--lang', 'en'], { cwd: f.directory });
    expect(en.stdout).toContain('model calls 0'); expect(en.stdout).toContain('pending review'); expect(en.stdout).toContain('unknown / unreported');
    expect(en.stdout).toContain('Review coverage: reviewed / expected / uncertain / missing');
    expect(en.stdout).toContain('Executor-reported attempts (not provider-internal requests)');
    expect(en.stdout).not.toContain('accepted within the declared scope');
    expect(settings).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(f.effects).toHaveBeenCalledTimes(calls);
    expect(treeDigest(f.workspace)).toBe(original); expect(readFileSync(join(f.home, 'settings.json'), 'utf8')).toBe('{invalid');
  });
  it('rejects study-only flags on other operations and unrelated study flags before opening files or settings', async () => {
    const directory = root(); vi.stubEnv('OMK_HOME', directory); writeFileSync(join(directory, 'settings.json'), '{invalid');
    const settings = vi.spyOn(UserSettingsStore.prototype, 'resolve').mockImplementation(() => { throw new Error('Unexpected settings access.'); });
    for (const flag of ['--evidence', '--author-review', '--reference-review', '--output-review', '--judge-review']) {
      await expect(runCommand(ObserveKnowledge, ['quality', flag, 'missing.json'], { cwd: directory })).rejects.toMatchObject({ code: 2 });
    }
    for (const flags of [[], ['--evidence', 'missing.json', '--workspace', directory], ['--evidence', 'missing.json', '--model', 'x'],
      ['--evidence', 'missing.json', '--generation-policy', '{}'], ['--evidence', 'missing.json', '--id', 'x']]) {
      await expect(runCommand(ObserveKnowledge, ['study', ...flags], { cwd: directory })).rejects.toMatchObject({ code: 2 });
    }
    expect(settings).not.toHaveBeenCalled();
  });
  it('rejects unreadable, linked, malformed, invalid-UTF8 and oversized files with bounded parameter diagnostics', async () => {
    const directory = root(), valid = join(directory, 'valid.json'), malformed = join(directory, 'malformed.json'), binary = join(directory, 'binary.json'),
      linked = join(directory, 'linked.json'), large = join(directory, 'large.json');
    writeFileSync(valid, '{}'); writeFileSync(malformed, 'PRIVATE-CLI-STUDY-SENTINEL invalid JSON');
    writeFileSync(binary, Buffer.from([0xff])); symlinkSync(valid, linked); writeFileSync(large, '{}'); truncateSync(large, EXTRACTION_STUDY_INSPECTION_MAX_BYTES + 1);
    const inspect = vi.spyOn(studyInspection, 'inspectExtractionStudy');
    for (const path of [join(directory, 'missing.json'), directory, linked, malformed, binary, large]) {
      await expect(runCommand(ObserveKnowledge, ['study', '--evidence', path, '--lang', 'en'], { cwd: directory }))
        .rejects.toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('--evidence is unreadable or invalid') });
    }
    expect(inspect).not.toHaveBeenCalled(); expect(readFileSync(malformed, 'utf8')).toBe('PRIVATE-CLI-STUDY-SENTINEL invalid JSON');
    // The wrapper can exceed capacity even when the selected raw file bytes fit.
    inspect.mockImplementation(() => { throw new ExtractionStudyInspectionError('knowledge_study_capacity_exceeded'); });
    await expect(runCommand(ObserveKnowledge, ['study', '--evidence', valid, '--lang', 'en'], { cwd: directory }))
      .rejects.toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('knowledge_study_capacity_exceeded') });
  });
  it.each(['knowledge_study_busy', 'knowledge_study_unavailable'] as const)('returns actionable service failure without leaking worker details: %s', async code => {
    const directory = root();
    vi.mocked(studyService.inspectExtractionStudyFiles).mockRejectedValue(new ExtractionStudyInspectionError(code));
    await expect(runCommand(ObserveKnowledge, ['study', '--evidence', 'PRIVATE-PATH.json', '--lang', 'en'], { cwd: directory }))
      .rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining(code === 'knowledge_study_busy' ? 'wait for it to finish' : 'worker failed or was cancelled') });
  });
  it('returns bounded evidence failures for changed native bytes, mismatched hosts and invalid review receipts', async () => {
    const f = await capturedFixture(), changed = structuredClone(f.evidence), invalid = join(f.directory, 'invalid-evidence.json');
    changed.records[0].outcomes[0].raw += ' ';
    writeFileSync(invalid, JSON.stringify(changed));
    await expect(runCommand(ObserveKnowledge, ['study', '--evidence', invalid, '--json'], { cwd: f.directory }))
      .rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('knowledge_study_evidence_invalid') });
    vi.spyOn(studyHost, 'extractionStudyHostIdentity').mockImplementation(() => ({ ...f.ports.identity(), runtimeDigest: `sha256:${'1'.repeat(64)}` }));
    await expect(runCommand(ObserveKnowledge, ['study', '--evidence', f.evidencePath], { cwd: f.directory }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('knowledge_study_host_mismatch') });
    vi.spyOn(studyHost, 'extractionStudyHostIdentity').mockImplementation(f.ports.identity);
    const receipt = join(f.directory, 'invalid-review.json'); writeFileSync(receipt, '{"private":"PRIVATE-REVIEW-SENTINEL"}');
    const result = runCommand(ObserveKnowledge, ['study', '--evidence', f.evidencePath, '--output-review', receipt], { cwd: f.directory });
    await expect(result).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('knowledge_study_evidence_invalid') });
    try { await result; } catch (error) { expect((error as { stderr: string }).stderr).not.toContain('PRIVATE-REVIEW-SENTINEL'); }
  });
  it('recomputes all selected fictional review receipts and distinguishes scoped, exploratory and blocked states', async () => {
    const f = await capturedFixture(true), original = treeDigest(f.workspace), calls = f.effects.mock.calls.length;
    // These shared authored receipts test gates only; no human or model made these decisions.
    const reviewFiles = [{ flag: 'author-review', value: f.authorReceipt }, { flag: 'reference-review', value: f.referenceReceipt },
      { flag: 'output-review', value: f.outputReceipt }, { flag: 'judge-review', value: f.judgeReceipt }].map(value => {
      const path = join(f.directory, `${value.flag}.json`); writeFileSync(path, JSON.stringify(value.value)); return { ...value, path };
    });
    const result = await runCommand(ObserveKnowledge, ['study', '--evidence', f.evidencePath, '--json', ...reviewFiles.flatMap(value => [`--${value.flag}`, value.path])], { cwd: f.directory });
    expect(JSON.parse(result.stdout)).toMatchObject({ review: { status: 'accepted_within_scope', reference: { goldReady: true },
      outputReview: { independentHuman: true } }, calibration: { ready: true } });
    const referenceFlags = reviewFiles.slice(0, 2).flatMap(value => [`--${value.flag}`, value.path]);
    const judgeOnly = await runCommand(ObserveKnowledge, ['study', '--evidence', f.evidencePath, ...referenceFlags,
      '--judge-review', reviewFiles[3].path, '--lang', 'en'], { cwd: f.directory });
    expect(judgeOnly.stdout).toContain('Semantic result：pending review');
    expect(judgeOnly.stdout).toContain('Saved exploratory AI review');
    expect(judgeOnly.stdout).toContain('AI exploration is shown separately');
    const exploratory = await runCommand(ObserveKnowledge, ['study', '--evidence', f.evidencePath, ...referenceFlags,
      '--output-review', reviewFiles[3].path, '--lang', 'en'], { cwd: f.directory });
    expect(exploratory.stdout).toContain('exploratory review complete; no independent human acceptance');
    const blockedReceipt = structuredClone(f.outputReceipt), decision = blockedReceipt.decisions.find(value => value.target.itemKind === 'case')!;
    decision.verdict = 'incorrect'; decision.errorCodes = ['provenance']; decision.rationale = 'Fictional authored critical error used only to verify CLI blocking.';
    const blockedPath = join(f.directory, 'blocked-review.json'); writeFileSync(blockedPath, JSON.stringify(blockedReceipt));
    const blocked = await runCommand(ObserveKnowledge, ['study', '--evidence', f.evidencePath, ...referenceFlags,
      '--output-review', blockedPath, '--lang', 'zh'], { cwd: f.directory });
    expect(blocked.stdout).toContain('语义结果：已阻断'); expect(blocked.stdout).toContain('critical_semantic_error');
    expect(result.stderr).toBe(''); expect(treeDigest(f.workspace)).toBe(original); expect(f.effects).toHaveBeenCalledTimes(calls);
    expect(existsSync(join(f.directory, 'report'))).toBe(false);
  });
});
