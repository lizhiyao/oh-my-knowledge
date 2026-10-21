import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { extractionStudyPanelBytesDigest as bytes } from '../../src/knowledge/extraction/study-panel.js';
import { parseKnowledgeStudyPanelArguments } from '../../scripts/bench/knowledge-study-panel.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-panel-cli-'))); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const url = (path: string) => pathToFileURL(join(repository, 'dist', path)).href;
  // Build-only production imports, explicitly authored source and fictional people; never model/human evidence.
  const setup = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import { createExtractionStudyPorts } from ${JSON.stringify(url('knowledge/application/study-local.js'))};
    import { freezeExtractionStudyCorpus, extractionStudyDigest as digest } from ${JSON.stringify(url('knowledge/extraction/study-corpus.js'))};
    import { SINGLE_EXTRACTION_POLICY } from ${JSON.stringify(url('knowledge/extraction/generation-policy.js'))};
    const forbidden = () => { throw new Error('Authored fixture cannot generate.'); };
    const actor = { actorKind: 'agent', actorId: 'authored-author', executionRef: 'authored-panel-fixture' };
    const ports = createExtractionStudyPorts({ workspace: './workspace', actor, model: forbidden, identity: forbidden });
    writeFileSync('./source.jsonl', JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
    const window = ports.application.capture({ path: process.cwd() + '/source.jsonl' });
    const corpus = freezeExtractionStudyCorpus({ corpusVersion: 'omk-extraction-study-corpus/v1', sourceKind: 'private-real', authors: [actor.actorId], cases: [{
      caseId: 'authored', split: 'development', exposure: 'seen', projectGroup: 'p', conversationGroup: 'c', lineageGroup: 'l', ancestorLineageIds: [],
      stratumId: 'authored', originDigest: digest('authored-only'), transformation: 'Authored CLI test; never real evidence.',
      sourceRecords: window.records.map(record => ({ recordIndex: record.recordIndex, recordId: 'authored:' + record.recordIndex, originalDigest: digest(record.raw) })),
      window, reference: { annotationScope: 'unannotated', entities: [], mentions: [], knowledge: [], semanticChecks: [] }
    }] });
    const configuration = { configurationVersion: 'omk-knowledge-extraction-study-configuration/v1', actor, changedVariable: 'replication', split: 'development', repeats: 1,
      criteria: { maxConfirmedErrors: 0, confirmedErrorsRationale: 'Authored test.', maxRequiredGaps: 0, requiredGapsRationale: 'Authored test.' },
      sampling: { selectionFrame: 'Authored fixture.', inclusionExclusion: 'Authored fixture.', unit: 'lineage-group', strata: [{ stratumId: 'authored', coverageRationale: 'CLI behavior.' }],
        sampleSizeRationale: 'No quality inference.', stoppingRule: 'Never run.', budgetRationale: 'Zero model calls.', interruptionPolicy: 'No generation.' },
      variants: ['baseline', 'candidate'].map(variantId => ({ variantId, executor: 'openai-api', model: 'authored', policy: SINGLE_EXTRACTION_POLICY })) };
    writeFileSync('./corpus.json', JSON.stringify(corpus)); writeFileSync('./configuration.json', JSON.stringify(configuration));
  `], { cwd: root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: root, OMK_HOME: join(root, 'omk-home'), CODEX_HOME: join(root, 'codex-home') } });
  expect(setup.status, setup.stderr).toBe(0);
  const execute = (entry: string, args: string[]) => spawnSync(process.execPath, [join(repository, 'dist-scripts/bench', entry + '.js'), ...args],
    { cwd: root, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: root, OMK_HOME: join(root, 'omk-home'), CODEX_HOME: join(root, 'codex-home'), OPENAI_API_KEY: 'authored-not-a-secret', OPENAI_BASE_URL: 'http://127.0.0.1:1' } });
  const study = join(root, 'study'), evidenceOutput = join(root, 'study-report');
  const prepare = execute('knowledge-study', ['prepare', '--workspace', workspace, '--study', study, '--corpus', join(root, 'corpus.json'), '--config', join(root, 'configuration.json')]);
  expect(prepare.status, prepare.stderr).toBe(0);
  const report = execute('knowledge-study', ['report', '--workspace', workspace, '--study', study, '--output', evidenceOutput]);
  expect(report.status, report.stderr).toBe(0);
  const evidence = join(evidenceOutput, 'evidence.json'), panelOutput = join(root, 'panel');
  const declaration = (actorId: string) => ({ reviewer: { actorKind: 'human', actorId }, independentHuman: true, authorRelationship: 'non_author', independenceRationale: 'Fictional authored CLI fixture; no human review occurred.' });
  writeFileSync(join(root, 'roster.json'), JSON.stringify({ raters: [declaration('fictional-a'), declaration('fictional-b')], adjudicator: declaration('fictional-third') }));
  const panel = execute('knowledge-study-panel', ['prepare', '--evidence', evidence, '--roster', join(root, 'roster.json'), '--mode', 'retrospective', '--output', panelOutput]);
  expect(panel.status, panel.stderr).toBe(0); expect(JSON.parse(panel.stdout)).toMatchObject({ modelCallsByThisCommand: 0, qualityAcceptance: 'not_assessed' });
  return { root, workspace, study, evidence, panelOutput, panel: read(join(panelOutput, 'panel.json')), execute };
}

describe('built offline study panel command', () => {
  it('requires explicit finite arguments and does not expose an execution/model flag', () => {
    expect(parseKnowledgeStudyPanelArguments(['--help'])).toBeNull();
    expect(() => parseKnowledgeStudyPanelArguments(['report', '--evidence', 'a'])).toThrow();
    expect(() => parseKnowledgeStudyPanelArguments(['prepare', '--evidence', 'e', '--roster', 'r', '--mode', 'prospective', '--output', 'o', '--model', 'x'])).toThrow();
    expect(() => parseKnowledgeStudyPanelArguments(['prepare', '--evidence', 'e', '--roster', 'r', '--mode', 'future', '--output', 'o'])).toThrow();
  });

  it('uses the actual built current-host replay, preserves original UTF-8 receipts and reports missing/retrospective coverage without passing quality', () => {
    const f = fixture(), rawEvidence = readFileSync(f.evidence, 'utf8'), originalPlan = readFileSync(join(f.study, 'plan.json'), 'utf8');
    const makeReceipt = (actorId: string) => JSON.stringify({ reviewVersion: 'omk-extraction-study-output-review/v1', planId: f.panel.planId, outputDigest: f.panel.outputDigest,
      reviewer: { actorKind: 'human', actorId }, independentHuman: true, reviewedAt: new Date().toISOString(),
      decisions: f.panel.targets.map((target: unknown) => ({ target, verdict: 'correct', referenceId: null, errorCodes: [], rationale: 'Fictional authored judgment; no human signed.' })) }, null, 2) + '\n';
    const original = makeReceipt('fictional-a'); writeFileSync(join(f.root, 'a.json'), original);
    const submission = { submissionVersion: 'omk-extraction-study-panel-submission/v1', panelId: f.panel.panelId,
      receipts: [{ reviewerId: 'fictional-a', receiptFile: 'a.json', receiptDigest: bytes(original) }] };
    const submissionPath = join(f.root, 'submission.json'); writeFileSync(submissionPath, JSON.stringify(submission, null, 2) + '\n');
    const args = (output: string) => ['report', '--evidence', f.evidence, '--panel', join(f.panelOutput, 'panel.json'), '--submission', submissionPath, '--output', output];
    const output = join(f.root, 'panel-report'), result = f.execute('knowledge-study-panel', args(output));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ modelCallsByThisCommand: 0, qualityAcceptance: 'not_assessed', fullIAA: null });
    const report = read(join(output, 'report.json'));
    expect(report.fullIAAUnavailableReasons).toEqual(expect.arrayContaining(['missing_roster_receipt', 'incomplete_target_coverage', 'retrospective_panel', 'incomplete_native_or_completion_evidence']));
    expect(readFileSync(join(output, 'initial-000.json'), 'utf8')).toBe(original);
    expect(readFileSync(join(output, 'submission.json'), 'utf8')).toBe(readFileSync(submissionPath, 'utf8'));
    expect(readFileSync(join(output, 'evidence.json'), 'utf8')).toBe(rawEvidence);
    const manifest = read(join(output, 'package-manifest.json'));
    for (const file of manifest.files) {
      const raw = readFileSync(join(output, file.name), 'utf8');
      expect(bytes(raw)).toBe(file.digest); expect(Buffer.byteLength(raw)).toBe(file.bytes);
      if (process.platform !== 'win32') expect(lstatSync(join(output, file.name)).mode & 0o777).toBe(0o600);
    }
    if (process.platform !== 'win32') expect(lstatSync(output).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(f.study, 'plan.json'), 'utf8')).toBe(originalPlan);
    expect(existsSync(join(f.workspace, 'extraction-runs'))).toBe(false);
    const overwritten = f.execute('knowledge-study-panel', args(output)); expect(overwritten.status).toBe(1);
    expect(readFileSync(join(output, 'initial-000.json'), 'utf8')).toBe(original);
    writeFileSync(f.evidence, rawEvidence + '\n');
    const drift = join(f.root, 'changed-evidence'), rejected = f.execute('knowledge-study-panel', args(drift));
    expect(rejected.status).toBe(1); expect(existsSync(drift)).toBe(false);
    expect(rejected.stderr).not.toContain('Alpha');
  });

  it('fails closed on a wrong raw receipt digest and duplicate physical receipt aliases before publishing', () => {
    const f = fixture(), receiptPath = join(f.root, 'same.json'), raw = '{}\n'; writeFileSync(receiptPath, raw);
    const submissionPath = join(f.root, 'submission.json'), output = join(f.root, 'denied');
    const run = () => f.execute('knowledge-study-panel', ['report', '--evidence', f.evidence, '--panel', join(f.panelOutput, 'panel.json'), '--submission', submissionPath, '--output', output]);
    writeFileSync(submissionPath, JSON.stringify({ submissionVersion: 'omk-extraction-study-panel-submission/v1', panelId: f.panel.panelId,
      receipts: [{ reviewerId: 'fictional-a', receiptFile: 'same.json', receiptDigest: bytes('different') }] }));
    expect(run().status).toBe(1); expect(existsSync(output)).toBe(false);
    writeFileSync(submissionPath, JSON.stringify({ submissionVersion: 'omk-extraction-study-panel-submission/v1', panelId: f.panel.panelId,
      receipts: [{ reviewerId: 'fictional-a', receiptFile: 'same.json', receiptDigest: bytes(raw) }, { reviewerId: 'fictional-b', receiptFile: './same.json', receiptDigest: bytes(raw) }] }));
    expect(run().status).toBe(1); expect(existsSync(output)).toBe(false);
  });
});
