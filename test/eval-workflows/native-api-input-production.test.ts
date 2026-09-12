import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestCanonicalJson } from '../../src/eval-core/contracts/index.js';
import { prepareCliEvaluation } from '../../src/cli/lib/prepare-evaluation.js';
import { runCoreEvaluationCommand } from '../../src/cli/lib/run-core-evaluation.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('authored input through the production API execution chain', () => {
  it.each(['openai-api', 'anthropic-api'])('preserves JSON and native history through %s with isolated gold', async (executor) => {
    const root = await mkdtemp(join(tmpdir(), 'omk-native-api-')); roots.push(root);
    vi.stubEnv('OMK_HOME', join(root, 'home')); vi.stubEnv('OMK_TREES_DIR', join(root, 'trees'));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const requests: Record<string, unknown>[] = [];
    // Only the provider transport is simulated; resolver, compiler, adapters and persistence are real.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const raw = String(init?.body); expect(raw).not.toContain('GOLD_SENTINEL');
      expect(raw).not.toContain('expectedPointer');

      const body = JSON.parse(raw); requests.push(body);
      const input = executor === 'openai-api' ? body.input : body.messages;
      const prompt = typeof input === 'string' ? input
        : input.length === 1 && typeof input[0].content === 'string' ? input[0].content : undefined;
      let answer: string;
      if (prompt !== undefined) {
        const task = JSON.parse(prompt.split('The input envelope is canonical JSON:\n')[1]!).task;
        expect(task.value).toEqual({ title: 'Invoice', count: 2, enabled: false });
        answer = task.value.title === 'Invoice' ? 'billing' : 'other';
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
    const schemaDocument = { $id: 'urn:omk-test:native-json', type: 'object', properties: {
      title: { type: 'string' }, count: { type: 'integer' }, enabled: { type: 'boolean' },
    }, required: ['title', 'count', 'enabled'], additionalProperties: false };
    const samples = [
      { sampleId: 'json', input: { inputKind: 'json', value: { title: 'Invoice', count: 2, enabled: false }, schemaDocument,
        schema: { schemaVersion: 'test/v1', schemaUri: schemaDocument.$id, schemaDigest: digestCanonicalJson(schemaDocument) } }, answer: 'billing' },
      { sampleId: 'history', input: { inputKind: 'messages', interactionMode: 'history', messages: [
        { messageId: 'u1', role: 'user', content: 'Remember K42' },
        { messageId: 'a1', role: 'assistant', content: 'Remembered.' },
        { messageId: 'u2', role: 'user', content: 'Which code?' },
      ] }, answer: 'K42' },
    ].map(({ answer, ...sample }) => ({ ...sample, expected: { answer, sentinel: 'GOLD_SENTINEL' },
      evaluationContext: { checks: [{ checkKind: 'exact-match', checkId: 'answer', actual: { sourceKind: 'output', pointer: '' }, expectedPointer: '/answer', layer: 'fact' }] } }));
    const path = join(root, 'samples.json'); await writeFile(path, JSON.stringify({ schemaVersion: 'omk.eval-sample-set/v3', samples }));
    const treatment = join(root, 'treatment'); await mkdir(treatment);
    await writeFile(join(treatment, 'SKILL.md'), '# Test\nAnswer the supplied task.\n');
    await writeFile(join(treatment, 'reference.txt'), 'NATIVE_SUPPORT_RESOURCE');
    const prepared = prepareCliEvaluation({ samples: path, executor, model: 'offline-fixture', control: 'baseline', treatment,
      'no-judge': true, 'skip-doctor': true, 'skip-connectivity': true, 'no-serve': true, 'output-dir': join(root, 'reports'),
    }, { projectRoot: root, lang: 'en', env: { ...process.env, OPENAI_API_KEY: 'offline-placeholder', ANTHROPIC_API_KEY: 'offline-placeholder' } });
    const result = await runCoreEvaluationCommand({ prepared });
    expect(requests).toHaveLength(4);
    expect(requests.filter((request) => JSON.stringify(request).includes('NATIVE_SUPPORT_RESOURCE'))).toHaveLength(2);
    expect(result.stored?.evaluation.records).toHaveLength(4);
    for (const record of result.stored!.evaluation.records) {
      expect(record.evaluationStatus).toBe('completed');
      if (record.evaluationStatus === 'completed') expect(record.observations).toEqual([
        expect.objectContaining({ observationStatus: 'observed', value: true }),
      ]);
    }
  });
});
