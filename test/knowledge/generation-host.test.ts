import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../src/executors/contracts/result.js';
import { createExtractionArchiveProducer } from '../../src/executors/archive.js';
import { createLocalKnowledgeGenerationModel, knowledgeGenerationEnvironment, KNOWLEDGE_GENERATION_ENVIRONMENT_POLICY } from '../../src/knowledge/adapters/generation-host.js';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { SOURCE_LEDGER_GENERATION_PROFILE } from '../../src/knowledge/extraction/source-review-wire.js';
import { sourceReviewInput } from '../../src/knowledge/extraction/source-review-input.js';
import { captureTraceFixture, sourceRef } from '../helpers/knowledge-source.js';

const fake = vi.hoisted(() => ({ environments: [] as NodeJS.ProcessEnv[], executionEnvironments: [] as NodeJS.ProcessEnv[], execute: vi.fn(async (): Promise<ExecResult> => ({ ok: true, output: '' } as ExecResult)) }));
vi.mock('../../src/executors/archive.js', async () => {
  const { createCodexArchiveProducer } = await import('../../src/executors/openai/codex/archive.js');
  return { createExtractionArchiveProducer(environment: NodeJS.ProcessEnv) {
    fake.environments.push(environment); return createCodexArchiveProducer(environment, (_name, options) => { fake.executionEnvironments.push(options.env); return fake.execute; });
  } };
});
const roots: string[] = [];
beforeEach(() => { fake.environments.length = 0; fake.executionEnvironments.length = 0; fake.execute.mockClear(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('removes only the observed per-call tracking key and makes key order deterministic without mutating the host', () => {
  const input = { Z: 'unchanged', PATH: '/explicit/path', CODEX_TOOL_CALL_ID: 'call-one', OPENAI_API_KEY: 'authored-secret-at-least-ten-characters' };
  const normalized = knowledgeGenerationEnvironment(input);
  expect(normalized).toEqual({ OPENAI_API_KEY: input.OPENAI_API_KEY, PATH: input.PATH, Z: input.Z });
  expect(Object.keys(normalized)).toEqual(['OPENAI_API_KEY', 'PATH', 'Z']); expect(Object.isFrozen(normalized)).toBe(true);
  expect(input.CODEX_TOOL_CALL_ID).toBe('call-one');
  expect(JSON.stringify(normalized)).toBe(JSON.stringify(knowledgeGenerationEnvironment({ PATH: input.PATH, Z: input.Z, OPENAI_API_KEY: input.OPENAI_API_KEY, CODEX_TOOL_CALL_ID: 'call-two' })));
});

it('confirms a prepared Codex request across distinct host instances while retaining real configuration drift checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-generation-host-')); roots.push(root);
  const source = captureTraceFixture(root, { path: join(root, 'authored.jsonl'), records: [{ recordIndex: 0,
    raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha remains a source assertion.' }] } }) }] });
  const refs = [sourceRef(source)], env = { PATH: '/authored/path', OPENAI_API_KEY: 'authored-secret-at-least-ten-characters' };
  const first = createLocalKnowledgeGenerationModel('codex', 'fixture', createExtractionArchiveProducer, { ...env, CODEX_TOOL_CALL_ID: 'first-tool-call' });
  const prepared = createLocalKnowledgeApplication(root).prepareGeneration(refs, first), request = prepared.journal.stages[0];
  expect(fake.execute).not.toHaveBeenCalled(); expect(request.producer.proof).toMatchObject({ hostEnvironmentPolicy: KNOWLEDGE_GENERATION_ENVIRONMENT_POLICY });
  for (const changedEnvironment of [{ ...env, PATH: '/different/path' }, { ...env, OPENAI_API_KEY: 'different-authored-secret-at-least-ten-characters' }]) {
    const changed = createLocalKnowledgeGenerationModel('codex', 'fixture', createExtractionArchiveProducer, { ...changedEnvironment, CODEX_TOOL_CALL_ID: 'second-tool-call' });
    await expect(createLocalKnowledgeApplication(root).generate(refs, changed, prepared.journal.runId, undefined,
      { confirmedRequestDigest: request.requestDigest })).rejects.toThrow('producer/profile changed');
    expect(fake.execute).not.toHaveBeenCalled();
  }
  fake.execute.mockResolvedValueOnce({ ok: true, output: JSON.stringify({ responseKind: 'knowledge-source-ledger', schemaVersion: 2,
    unitDispositions: sourceReviewInput([source]).units.map(unit => ({ unitKey: unit.unitKey, disposition: 'exclude',
      reason: 'Authored transport fixture only; no semantic acceptance.' })),
    items: [], limitations: ['Transport and native custody verification only.'] }) } as ExecResult);
  const second = createLocalKnowledgeGenerationModel('codex', 'fixture', createExtractionArchiveProducer, { CODEX_TOOL_CALL_ID: 'second-tool-call', OPENAI_API_KEY: env.OPENAI_API_KEY, PATH: env.PATH });
  expect(second.inspect(SOURCE_LEDGER_GENERATION_PROFILE, request.input)).toEqual(request.producer);
  const sent = await createLocalKnowledgeApplication(root).generate(refs, second, prepared.journal.runId, undefined, { confirmedRequestDigest: request.requestDigest });
  expect(sent.journal.ledgerRef).toBeDefined(); expect(sent.journal.bodies).toHaveLength(0);
  expect(sent.nextAction).toBe('prepare_next_stage'); expect(fake.execute).toHaveBeenCalledTimes(1);
  expect(fake.environments.every(value => !Object.hasOwn(value, 'CODEX_TOOL_CALL_ID'))).toBe(true);
  expect(fake.environments.at(-1)).toEqual(env); expect(fake.executionEnvironments).toEqual([env]);
});
