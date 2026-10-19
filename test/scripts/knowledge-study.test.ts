import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(repository, 'dist-scripts/bench/knowledge-study.js');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('built repository knowledge study entry', () => {
  it('prepares and reports captured authored evidence through separate built CLI processes without authorizing generation', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-commands-'))); roots.push(root);
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const moduleUrl = (path: string) => pathToFileURL(join(repository, 'dist', path)).href;
    // Build-only imports and independent CLI processes verify the repository delivery boundary.
    const setup = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs';
      import { createExtractionStudyPorts } from ${JSON.stringify(moduleUrl('knowledge/application/study-local.js'))};
      import { freezeExtractionStudyCorpus, extractionStudyDigest as digest } from ${JSON.stringify(moduleUrl('knowledge/extraction/study-corpus.js'))};
      import { SINGLE_EXTRACTION_POLICY } from ${JSON.stringify(moduleUrl('knowledge/extraction/generation-policy.js'))};
      const forbidden = () => { throw new Error('Fixture setup cannot generate.'); };
      const actor = { actorKind: 'agent', actorId: 'authored-entry-test', executionRef: 'authored-entry-fixture' };
      const ports = createExtractionStudyPorts({ workspace: './workspace', actor, model: forbidden, identity: forbidden });
      writeFileSync('./source.jsonl', JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
      const window = ports.application.capture({ path: process.cwd() + '/source.jsonl' });
      const corpus = freezeExtractionStudyCorpus({ corpusVersion: 'omk-extraction-study-corpus/v1', sourceKind: 'private-real', authors: [actor.actorId], cases: [{
        caseId: 'authored-case', split: 'development', exposure: 'seen', projectGroup: 'p', conversationGroup: 'c', lineageGroup: 'l', ancestorLineageIds: [],
        stratumId: 'authored', originDigest: digest('authored-only'), transformation: 'Authored CLI boundary test; never real study evidence.',
        sourceRecords: window.records.map(record => ({ recordIndex: record.recordIndex, recordId: 'authored:' + record.recordIndex, originalDigest: digest(record.raw) })),
        window, reference: { annotationScope: 'unannotated', entities: [], mentions: [], knowledge: [], semanticChecks: [] }
      }] });
      const configuration = { configurationVersion: 'omk-knowledge-extraction-study-configuration/v1', actor, changedVariable: 'replication', split: 'development', repeats: 1,
        criteria: { maxConfirmedErrors: 0, confirmedErrorsRationale: 'Authored test.', maxRequiredGaps: 0, requiredGapsRationale: 'Authored test.' },
        sampling: { selectionFrame: 'Authored fixture.', inclusionExclusion: 'Authored fixture only.', unit: 'lineage-group', strata: [{ stratumId: 'authored', coverageRationale: 'CLI behavior.' }],
          sampleSizeRationale: 'No quality inference.', stoppingRule: 'Never execute this test plan.', budgetRationale: 'Zero model calls.', interruptionPolicy: 'No generation authorized.' },
        variants: ['baseline', 'candidate'].map(variantId => ({ variantId, executor: 'openai-api', model: 'authored-loopback-test', policy: SINGLE_EXTRACTION_POLICY })) };
      writeFileSync('./corpus.json', JSON.stringify(corpus)); writeFileSync('./configuration.json', JSON.stringify(configuration));
    `], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    expect(setup.status, setup.stderr).toBe(0);
    const execute = (args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { TMPDIR: tmpdir(), PATH: process.env.PATH, OPENAI_API_KEY: 'authored-not-a-secret', OPENAI_BASE_URL: 'http://127.0.0.1:1' } });
    const study = join(root, 'study'), output = join(root, 'report');
    const prepared = execute(['prepare', '--workspace', workspace, '--study', study, '--corpus', join(root, 'corpus.json'), '--config', join(root, 'configuration.json')]);
    expect(prepared.status, prepared.stderr).toBe(0); expect(JSON.parse(prepared.stdout)).toMatchObject({ slots: 2, modelCallsByThisCommand: 0, goldReady: false });
    const reported = execute(['report', '--workspace', workspace, '--study', study, '--output', output]);
    expect(reported.status, reported.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
    expect(report.summary).toMatchObject({ planned: 2, unattempted: 2, totalCostUSD: null });
    expect(report.analysis).toMatchObject({ goldReady: false, studyStatus: 'blocked' });
    expect(report.independentReferenceTemplate.reviewer.actorId).toBe('');
    const plan = JSON.parse(readFileSync(join(study, 'plan.json'), 'utf8'));
    const denied = execute(['run', '--workspace', workspace, '--study', study, '--slot', plan.slots[0].slotId, '--authorize-plan', 'sha256:wrong']);
    expect(denied.status).toBe(1);
    expect(existsSync(join(workspace, 'extraction-runs')) ? readdirSync(join(workspace, 'extraction-runs')) : []).toEqual([]);
  });
  it('freezes shared runtime and installed validator code and schema bytes, beyond dependency versions', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-host-'))); roots.push(root);
    cpSync(join(repository, 'dist'), join(root, 'dist'), { recursive: true,
      filter: path => !path.startsWith(join(repository, 'dist/studio/web')) });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const require = createRequire(import.meta.url), pending = ['zod', 'ajv', 'js-yaml', 'smol-toml'];
    const copied = new Set<string>();
    for (const name of pending) {
      if (copied.has(name)) continue;
      let directory = dirname(realpathSync(require.resolve(name)));
      while (!existsSync(join(directory, 'package.json')) || JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name !== name) directory = dirname(directory);
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      cpSync(directory, join(root, 'node_modules', name), { recursive: true,
        filter: path => !path.startsWith(join(directory, 'node_modules')) });
      copied.add(name); pending.push(...Object.keys(manifest.dependencies ?? {}));
    }
    // One real module-scope process exercises import.meta.url and physical installed dependency resolution.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { appendFileSync, readdirSync } from 'node:fs';
      import { extractionStudyHostIdentity as identity } from './dist/knowledge/adapters/study-host.js';
      const values = [identity()];
      appendFileSync('./dist/shared/atomic-json.js', '\\n// isolated shared runtime mutation\\n'); values.push(identity());
      appendFileSync('./node_modules/ajv/dist/2020.js', '\\n// isolated validator mutation\\n'); values.push(identity());
      const schema = './node_modules/ajv/dist/refs/' + readdirSync('./node_modules/ajv/dist/refs').find(name => name.endsWith('.json'));
      appendFileSync(schema, '\\n '); values.push(identity());
      process.stdout.write(JSON.stringify(values));
    `], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    const [initial, shared, validator, schema] = JSON.parse(result.stdout);
    expect(shared.runtimeDigest).not.toBe(initial.runtimeDigest);
    expect(shared.dependencyDigest).toBe(initial.dependencyDigest);
    expect(validator.dependencyDigest).not.toBe(shared.dependencyDigest);
    expect(schema.dependencyDigest).not.toBe(validator.dependencyDigest);
    expect(schema.nodeBinaryDigest).toBe(initial.nodeBinaryDigest);
  });
  it('does not leak malformed private corpus bytes or paths in a bounded failure diagnostic', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-entry-'))); roots.push(root);
    const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const corpus = join(root, 'private-corpus.json'), config = join(root, 'configuration.json');
    const raw = 'PRIVATE-KNOWLEDGE-STUDY-SENTINEL invalid JSON'; writeFileSync(corpus, raw); writeFileSync(config, '{}');
    const result = spawnSync(process.execPath, [script, 'prepare', '--workspace', workspace, '--study', join(root, 'new-study'), '--corpus', corpus, '--config', config],
      { cwd: root, env: { TMPDIR: tmpdir(), PATH: process.env.PATH }, encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).toBe('knowledge_study_failed: 输入、冻结身份或执行未通过；原文和原生证据保留在显式研究目录。\n');
    expect(result.stderr).not.toContain(raw); expect(result.stderr).not.toContain(root); expect(readFileSync(corpus, 'utf8')).toBe(raw);
  });
});
