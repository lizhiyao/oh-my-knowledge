import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestCanonicalJson } from '../../src/eval-core/contracts/index.js';
import { prepareCliEvaluation } from '../../src/cli/lib/prepare-evaluation.js';
import { runCoreEvaluationCommand } from '../../src/cli/lib/run-core-evaluation.js';
import { compileCliEvaluationInput } from '../../src/eval-workflows/input-compilation/index.js';
import { resolveNodeCliEvaluationRequest } from '../../src/eval-workflows/hosts/input-resolution/node-cli-evaluation-resolver.js';
import type { SampleInput } from '../../src/eval-workflows/inputs/contracts/sample-input.js';
import type { StoredCoreRunArtifacts } from '../../src/eval-workflows/artifact-store/index.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omk-cross-executor-')); roots.push(root);
  vi.stubEnv('OMK_HOME', join(root, 'home')); vi.stubEnv('OMK_TREES_DIR', join(root, 'trees'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const schemaDocument = { $id: 'urn:omk-test:native-json', type: 'object', properties: {
    title: { type: 'string' }, count: { type: 'integer' }, enabled: { type: 'boolean' },
  }, required: ['title', 'count', 'enabled'], additionalProperties: false };
  const cases: { sampleId: string; input: SampleInput; answer: string }[] = [
    { sampleId: 'text', input: { inputKind: 'text', text: 'Remember K42' }, answer: 'K42' },
    { sampleId: 'wrong-reference', input: { inputKind: 'text', text: 'Remember K42' }, answer: 'deliberately wrong' },
    { sampleId: 'json', input: { inputKind: 'json', value: { title: 'Invoice', count: 2, enabled: false }, schemaDocument,
      schema: { schemaVersion: 'test/v1', schemaUri: schemaDocument.$id, schemaDigest: digestCanonicalJson(schemaDocument) } }, answer: 'billing' },
    { sampleId: 'history', input: { inputKind: 'messages', interactionMode: 'history', messages: [
      { messageId: 'u1', role: 'user', content: 'Remember K42' },
      { messageId: 'a1', role: 'assistant', content: 'Remembered.' },
      { messageId: 'u2', role: 'user', content: 'Which code?' },
    ] }, answer: 'K42' },
  ];
  const samples = cases.map(({ answer, ...sample }) => ({ ...sample, expected: { answer, sentinel: 'GOLD_SENTINEL' },
    evaluationContext: { checks: [{ checkKind: 'exact-match', checkId: 'answer', actual: { sourceKind: 'output', pointer: '' }, expectedPointer: '/answer', layer: 'fact' }] } }));
  const path = join(root, 'samples.json'); await writeFile(path, JSON.stringify({ schemaVersion: 'omk.eval-sample-set/v3', samples }));
  const treatment = join(root, 'treatment'); await mkdir(treatment);
  await writeFile(join(treatment, 'SKILL.md'), '# Test\nAnswer the supplied task.\n');
  await writeFile(join(treatment, 'reference.txt'), 'NATIVE_SUPPORT_RESOURCE');
  return { root, path, treatment, cases, samples };
}

function prepare(f: Awaited<ReturnType<typeof fixture>>, executor: string, suffix = executor) {
  return prepareCliEvaluation({ samples: f.path, executor, model: 'offline-fixture', control: 'baseline', treatment: f.treatment,
    'no-judge': true, 'skip-doctor': true, 'skip-connectivity': true, 'no-serve': true, 'output-dir': join(f.root, suffix, 'reports'),
  }, { projectRoot: f.root, lang: 'en', env: { ...process.env, OPENAI_API_KEY: 'offline-placeholder', ANTHROPIC_API_KEY: 'offline-placeholder', OPENAI_BASE_URL: 'https://api.openai.com/v1', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
}

describe('one authored sample set across production executors', () => {
  it('preserves input and grading across both APIs and a custom executor without conflating runtime identities', async () => {
    const f = await fixture();
    const original = await readFile(f.path, 'utf8');
    const artifacts: StoredCoreRunArtifacts[] = [];
    const history = f.cases.find(c => c.input.inputKind === 'messages')!.input as Extract<SampleInput, { inputKind: 'messages' }>;
    const custom = join(f.root, 'executor.mjs');
    await writeFile(custom, `#!${process.execPath}
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
assert(!raw.includes('GOLD_SENTINEL'));assert(!raw.includes('expectedPointer'));
const request=JSON.parse(raw);assert.equal(request.schemaVersion,'omk.custom-executor-exchange/v1');
const input=request.trial.input;
if(input.inputKind==='json')assert.deepEqual(input.value,{title:'Invoice',count:2,enabled:false});
if(input.inputKind==='messages')assert.deepEqual(input.messages,${JSON.stringify(history.messages)});
const answer=typeof input==='string'?input.slice('Remember '.length):input.inputKind==='json'?(input.value.title==='Invoice'?'billing':'other'):input.messages[0].content.slice('Remember '.length);
const artifact=request.resources.find(r=>r.resourceId===request.trial.targetConfig.behavior.artifact.resourceId);
assert(artifact);readFileSync(artifact.snapshotPath+(artifact.snapshotKind==='directory'?'/SKILL.md':''),'utf8');
console.log(JSON.stringify({schemaVersion:request.schemaVersion,resultStatus:'completed',output:{value:answer,classification:'public'}}));
`);
    await chmod(custom, 0o700);
    for (const executor of ['openai-api', 'anthropic-api', 'custom-executor']) {
      const requests: Record<string, unknown>[] = [];
      // Only HTTP transport is simulated; the custom executor runs as a real isolated subprocess.
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        expect(String(url)).toBe(executor === 'openai-api' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages');
        const raw = String(init?.body); expect(raw).not.toContain('GOLD_SENTINEL');
        expect(raw).not.toContain('expectedPointer');
        const body = JSON.parse(raw); requests.push(body);
        const input = executor === 'openai-api' ? body.input : body.messages;
        const prompt = typeof input === 'string' ? input
          : input.length === 1 && typeof input[0].content === 'string' ? input[0].content : undefined;
        let answer: string;
        if (prompt !== undefined) {
          const task = JSON.parse(prompt.split('The input envelope is canonical JSON:\n')[1]!).task;
          if (typeof task === 'string') answer = task.slice('Remember '.length);
          else {
            expect(task.value).toEqual({ title: 'Invoice', count: 2, enabled: false });
            answer = task.value.title === 'Invoice' ? 'billing' : 'other';
          }
        } else {
          expect(input.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant', 'user']);
          const first = input[0].content;
          const text = typeof first === 'string' ? first : first.at(-1).text;
          answer = text.slice('Remember '.length);
        }
        const response = executor === 'openai-api'
          ? { object: 'response', model: 'offline-fixture', status: 'completed', output: [{ id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer }] }] }
          : { type: 'message', model: 'offline-fixture', role: 'assistant', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: answer }] };
        return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
      });
      const result = await runCoreEvaluationCommand({ prepared: prepare(f, executor === 'custom-executor' ? custom : executor, executor) });
      if (executor === 'custom-executor') expect(fetch).not.toHaveBeenCalled();
      else {
        expect(requests).toHaveLength(8);
        expect(requests.filter((request) => JSON.stringify(request).includes('NATIVE_SUPPORT_RESOURCE'))).toHaveLength(4);
      }
      fetch.mockRestore();
      expect(result.stored).toBeDefined();
      expect(result.output).toMatchObject({ gate: { reasonCodes: ['core-release-verdict-blocked', 'comparison-not-significant', 'comparison-sample-size-below-minimum'] } });
      const stored = result.stored!; artifacts.push(stored);
      expect(stored.evaluation.records).toHaveLength(8);
      expect(stored.analysis.analysisBundleStatus).not.toBe('failed');
      expect(stored.analysis.records.filter(r => r.analysisStatus === 'failed')).toEqual([]);
      expect(stored.analysis.records.find(r => r.nodeId === 'assertion-layer')?.analysisStatus).toBe('completed');
      expect(stored.analysis.records.find(r => r.nodeId === 'composite-table')?.analysisStatus).toBe('completed');
      for (const record of stored.evaluation.records) {
        expect(record.evaluationStatus).toBe('completed');
        if (record.evaluationStatus === 'completed') expect(record.observations).toEqual([
          expect.objectContaining({ observationStatus: 'observed', value: record.sampleId !== 'wrong-reference' }),
        ]);
      }
      expect(await readFile(f.path, 'utf8')).toBe(original);
    }
    // Same authored data and evaluator; executor identity must remain a separate experimental condition.
    for (const current of artifacts.slice(1)) {
      expect(current.plan.definition.dataset).toEqual(artifacts[0]!.plan.definition.dataset);
      expect(current.evaluation.records.map(r => r.runtime)).toEqual(artifacts[0]!.evaluation.records.map(r => r.runtime));
      expect(current.plan.digests.executionPlanDigest).not.toBe(artifacts[0]!.plan.digests.executionPlanDigest);
    }
    expect(new Set(artifacts.map(a => a.execution.records[0]!.runtime.implementationId)).size).toBe(3);
  });

  it.each(['openai-api', 'anthropic-api'])('rejects a valid tool history before %s transport', async (executor) => {
    const f = await fixture();
    const input: SampleInput = { inputKind: 'messages', interactionMode: 'history', messages: [
      { messageId: 'u', role: 'user', content: 'Read the code.' },
      { messageId: 'a', role: 'assistant', content: '', toolCalls: [{ toolCallId: 'call', name: 'read', arguments: { file: 'code.txt' } }] },
      { messageId: 't', role: 'tool', toolCallId: 'call', content: 'K42' },
      { messageId: 'u2', role: 'user', content: 'Which code?' },
    ] };
    await writeFile(f.path, JSON.stringify({ schemaVersion: 'omk.eval-sample-set/v3', samples: [{ ...f.samples[0], sampleId: 'tools', input }] }));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'));
    await expect(runCoreEvaluationCommand({ prepared: prepare(f, executor) })).rejects.toMatchObject({
      code: 'CLI_INPUT_INVALID', fieldPath: 'samples.tools.input', message: expect.stringContaining('custom-executor'),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['codex', 'codex-sdk', 'claude', 'claude-sdk'])('compiles the same text sample and rejects JSON/history before executing %s', async (executor) => {
    const f = await fixture();
    for (const sample of f.samples) {
      await writeFile(f.path, JSON.stringify({ schemaVersion: 'omk.eval-sample-set/v3', samples: [sample] }));
      const prepared = prepare(f, executor);
      const resolve = resolveNodeCliEvaluationRequest(prepared.request, { projectRoot: f.root, materializationRoot: join(f.root, 'resolved') });
      if (sample.input.inputKind === 'text') {
        const compiled = compileCliEvaluationInput(await resolve);
        expect(compiled.definition.dataset.samples[0]!.input).toBe(sample.input.text);
        expect(compiled.definition.targets.every(t => t.executorId === executor)).toBe(true);
      } else await expect(resolve).rejects.toMatchObject({ code: 'CLI_INPUT_INVALID', fieldPath: `samples.${sample.sampleId}.input`, message: expect.stringContaining('only text samples') });
    }
  });
});
