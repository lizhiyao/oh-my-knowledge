import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { copyStudyRuntime } from '../helpers/study-runtime.js';

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
  it('carries configured and default timeouts through the built study host, native producer and frozen run without configuration drift', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-timeout-'))); roots.push(root);
    const moduleUrl = (path: string) => pathToFileURL(join(repository, 'dist', path)).href;
    // Production composition and producer; the executor return is authored and has no provider access.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { createExtractionStudyPorts, executeLocalExtractionStudy as execute } from ${JSON.stringify(moduleUrl('knowledge/application/study-local.js'))};
      import { ExtractionStudyFiles } from ${JSON.stringify(moduleUrl('knowledge/adapters/study-files.js'))};
      import { freezeExtractionStudyCorpus, extractionStudyDigest as digest } from ${JSON.stringify(moduleUrl('knowledge/extraction/study-corpus.js'))};
      import { SINGLE_EXTRACTION_POLICY } from ${JSON.stringify(moduleUrl('knowledge/extraction/generation-policy.js'))};
      import { createCodexArchiveProducer } from ${JSON.stringify(moduleUrl('executors/openai/codex/archive.js'))};
      const repository = ${JSON.stringify(repository)}, root = process.cwd(), workspace = join(root, 'workspace'); mkdirSync(workspace);
      const effects = [], producerCalls = [];
      const actual = createCodexArchiveProducer({}, () => async input => {
        effects.push(input.timeoutMs);
        return { ok: true, stopReason: 'completed', output: JSON.stringify({ responseKind: 'knowledge-extraction', schemaVersion: 4, entities: [], mentions: [], proposals: [] }),
          durationMs: 1, durationApiMs: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
          costUSD: 0, costReportedByExecutor: false, numTurns: 1 };
      });
      const producer = Object.fromEntries(['assertCapabilities', 'inspect', 'configure'].map(name => [name, (...args) => {
        producerCalls.push({ name, timeoutMs: args[1].timeoutMs }); return actual[name](...args);
      }]));
      const forbidden = () => { throw new Error('Capture cannot generate.'); };
      const actor = { actorKind: 'agent', actorId: 'authored-timeout-test', executionRef: 'authored-timeout-fixture' };
      const ports = createExtractionStudyPorts({ workspace, actor, model: forbidden, identity: forbidden });
      const source = join(root, 'source.jsonl');
      writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Authored timeout boundary.' }] } }));
      const window = ports.application.capture({ path: source });
      const corpus = freezeExtractionStudyCorpus({ corpusVersion: 'omk-extraction-study-corpus/v1', sourceKind: 'private-real', authors: [actor.actorId], cases: [{
        caseId: 'authored-timeout', split: 'development', exposure: 'seen', projectGroup: 'p', conversationGroup: 'c', lineageGroup: 'l', ancestorLineageIds: [],
        stratumId: 'authored', originDigest: digest('authored-only'), transformation: 'Authored timeout wiring test; no quality evidence.',
        sourceRecords: window.records.map(record => ({ recordIndex: record.recordIndex, recordId: 'authored:' + record.recordIndex, originalDigest: digest(record.raw) })),
        window, reference: { annotationScope: 'unannotated', entities: [], mentions: [], knowledge: [], semanticChecks: [] }
      }] });
      const corpusPath = join(root, 'corpus.json'), configPath = join(root, 'configuration.json'); writeFileSync(corpusPath, JSON.stringify(corpus));
      const configuration = timeouts => ({ configurationVersion: 'omk-knowledge-extraction-study-configuration/v1', actor,
        changedVariable: 'replication', split: 'development', repeats: 1,
        criteria: { maxConfirmedErrors: 0, confirmedErrorsRationale: 'Authored test.', maxRequiredGaps: 0, requiredGapsRationale: 'Authored test.' },
        sampling: { selectionFrame: 'Authored fixture.', inclusionExclusion: 'Authored fixture only.', unit: 'lineage-group', strata: [{ stratumId: 'authored', coverageRationale: 'Timeout wiring.' }],
          sampleSizeRationale: 'No quality inference.', stoppingRule: 'One authored invocation per plan.', budgetRationale: 'No provider calls.', interruptionPolicy: 'Do not retry.' },
        variants: ['baseline', 'candidate'].map((variantId, index) => ({ variantId, executor: 'codex', model: 'fixture', policy: SINGLE_EXTRACTION_POLICY,
          ...(timeouts[index] === undefined ? {} : { timeoutMs: timeouts[index] }) })) });
      const request = (command, study, extra = {}) => execute({ command, repository, runnerFile: ${JSON.stringify(script)}, producer,
        values: { '--workspace': workspace, '--study': study, '--corpus': corpusPath, '--config': configPath, ...extra } });
      for (const [index, timeoutMs] of [0, -1, 0.5, 2147483648, Number.MAX_SAFE_INTEGER + 1, null, '600000'].entries()) {
        const study = join(root, 'invalid-' + index); writeFileSync(configPath, JSON.stringify(configuration([timeoutMs, timeoutMs])));
        await assert.rejects(request('prepare', study)); assert.equal(existsSync(study), false);
      }
      writeFileSync(configPath, JSON.stringify(configuration([300000, 600000])));
      await assert.rejects(request('prepare', join(root, 'drift')), /more than its declared variable/);
      assert.equal(existsSync(join(root, 'drift')), false); assert.deepEqual(producerCalls, []); assert.deepEqual(effects, []);
      const observed = [];
      for (const [name, timeouts, expected] of [['explicit', [600000, 600000], 600000], ['default', [], 300000]]) {
        const study = join(root, name); writeFileSync(configPath, JSON.stringify(configuration(timeouts)));
        const prepared = await request('prepare', study), files = new ExtractionStudyFiles({ directory: study, workspace, repository }), { plan } = files.open();
        assert.equal(prepared.modelCallsByThisCommand, 0); assert.deepEqual(effects, observed.map(value => value.actual));
        assert.deepEqual(plan.variants.map(value => value.timeoutMs), [expected, expected]);
        assert.deepEqual(plan.slots.map(value => value.request.timeoutMs), [expected, expected]);
        assert.ok(producerCalls.every(value => value.timeoutMs === expected)); producerCalls.length = 0;
        // Changing the source configuration cannot change a previously prepared plan, including a default-300000 plan.
        writeFileSync(configPath, JSON.stringify(configuration([1200000, 1200000])));
        const slot = plan.slots[0], advanced = await request('run', study, { '--slot': slot.slotId, '--authorize-plan': plan.planId });
        assert.equal(advanced.exitCode, 0); assert.equal(advanced.omkDispatchesByThisCommand, 1);
        const run = JSON.parse(readFileSync(join(workspace, 'extraction-runs', slot.runId + '.json'), 'utf8'));
        assert.equal(run.status, 'completed'); assert.equal(run.attempts.length, 1);
        assert.equal(run.attempts[0].request.timeoutMs, expected); assert.deepEqual(run.attempts[0].producer, slot.producer);
        assert.ok(producerCalls.every(value => value.timeoutMs === expected)); producerCalls.length = 0;
        const output = join(root, name + '-report'); await request('report', study, { '--output': output });
        const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
        assert.equal(report.slots[0].nativeVerified, true); assert.equal(report.summary.attempts, 1);
        observed.push({ configured: expected, actual: effects.at(-1), run: run.attempts[0].request.timeoutMs, nativeVerified: report.slots[0].nativeVerified });
      }
      assert.deepEqual(effects, [600000, 300000]); process.stdout.write(JSON.stringify(observed));
    `], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { configured: 600_000, actual: 600_000, run: 600_000, nativeVerified: true },
      { configured: 300_000, actual: 300_000, run: 300_000, nativeVerified: true },
    ]);
  });
  it('freezes shared runtime and installed validator code and schema bytes, beyond dependency versions', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-study-host-'))); roots.push(root);
    copyStudyRuntime(repository, root);
    // One real module-scope process exercises import.meta.url and physical installed dependency resolution.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
      import { extractionStudyHostIdentity as identity } from './dist/knowledge/adapters/study-host.js';
      const values = [identity()];
      appendFileSync('./dist/shared/atomic-json.js', '\\n// isolated shared runtime mutation\\n'); values.push(identity());
      appendFileSync('./node_modules/ajv/dist/2020.js', '\\n// isolated validator mutation\\n'); values.push(identity());
      const schema = './node_modules/ajv/dist/refs/' + readdirSync('./node_modules/ajv/dist/refs').find(name => name.endsWith('.json'));
      appendFileSync(schema, '\\n '); values.push(identity());
      const manifest = './node_modules/zod/package.json', data = JSON.parse(readFileSync(manifest, 'utf8'));
      data.dependencies = { ...data.dependencies, 'omk-authored-validator': '1.0.0' }; writeFileSync(manifest, JSON.stringify(data));
      mkdirSync('./node_modules/omk-authored-validator');
      writeFileSync('./node_modules/omk-authored-validator/package.json', '{"name":"omk-authored-validator","version":"1.0.0","main":"index.js"}');
      writeFileSync('./node_modules/omk-authored-validator/index.js', 'module.exports = 1;'); values.push(identity());
      appendFileSync('./node_modules/omk-authored-validator/index.js', '\\n// same-version validator drift\\n'); values.push(identity());
      rmSync('./node_modules/omk-authored-validator', { recursive: true });
      let missingRejected = false; try { identity(); } catch { missingRejected = true; } values.push({ missingRejected });
      process.stdout.write(JSON.stringify(values));
    `], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    const [initial, shared, validator, schema, added, changed, missing] = JSON.parse(result.stdout);
    expect(shared.runtimeDigest).not.toBe(initial.runtimeDigest);
    expect(shared.dependencyDigest).toBe(initial.dependencyDigest);
    expect(validator.dependencyDigest).not.toBe(shared.dependencyDigest);
    expect(schema.dependencyDigest).not.toBe(validator.dependencyDigest);
    expect(schema.nodeBinaryDigest).toBe(initial.nodeBinaryDigest);
    expect(added.dependencyDigest).not.toBe(schema.dependencyDigest); expect(changed.dependencyDigest).not.toBe(added.dependencyDigest);
    expect(changed.runtimeDigest).toBe(schema.runtimeDigest); expect(missing.missingRejected).toBe(true);
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
