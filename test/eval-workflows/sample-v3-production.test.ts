import { chmod, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digestCanonicalJson, type JsonValue } from '../../src/eval-core/contracts/index.js';
import { prepareCliEvaluation } from '../../src/cli/lib/prepare-evaluation.js';
import { runCoreEvaluationCommand } from '../../src/cli/lib/run-core-evaluation.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function jsonInput(value: Record<string, JsonValue>) {
  const schemaDocument = { $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:omk-test:${value.task}:v1`, type: 'object', additionalProperties: false,
    required: Object.keys(value), properties: Object.fromEntries(Object.entries(value).map(([key, v]) =>
      [key, { type: typeof v }])) };
  return { inputKind: 'json', value, schemaDocument,
    schema: { schemaVersion: 'test.application/v1', schemaUri: schemaDocument.$id,
      schemaDigest: digestCanonicalJson(schemaDocument) } };
}
const program = `
import {readFileSync,writeFileSync} from 'node:fs';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const request=JSON.parse(raw);
if(raw.includes('GOLD_SENTINEL') || Object.hasOwn(request.trial,'expected') || Object.hasOwn(request.trial,'evaluationContext')) throw new Error('Gold leaked');
const input=request.trial.input;
let result;
if(input.inputKind==='messages') {
  const inventory=JSON.parse(readFileSync('inventory.json','utf8'));
  const sku=input.messages.at(-1).content;
  result={sku,stock:inventory[sku]};
} else if(input.value.task==='classification') {
  result=/invoice/i.test(input.value.title)?'billing':'general';
} else if(input.value.task==='retrieval') {
  const corpus=JSON.parse(readFileSync('corpus.json','utf8'));
  result=corpus.map(doc=>({...doc,score:doc.text.split(' ').filter(word=>input.value.query.split(' ').includes(word)).length}))
    .sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,2).map(doc=>doc.id);
} else {
  const status=input.value.amount<0?'rejected':input.value.amount>100?'manual':'approved';
  writeFileSync('state.json',JSON.stringify({status}));
  result=JSON.parse(readFileSync('state.json','utf8'));
}
process.stdout.write(JSON.stringify({schemaVersion:'omk.custom-command-exchange/v1',resultStatus:'completed',
 output:{value:{result},classification:'public'},trace:{value:{isolationChecked:true},classification:'public'}}));
`;

async function run(mode: 'correct' | 'wrong' | 'missing') {
  const root = await mkdtemp(join(tmpdir(), 'omk-v3-production-')); roots.push(root);
  vi.stubEnv('OMK_HOME', join(root, 'home')); vi.stubEnv('OMK_TREES_DIR', join(root, 'trees'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const cwd = join(root, 'fixture'); await mkdir(cwd);
  await writeFile(join(cwd, 'inventory.json'), JSON.stringify({ red: 3, blue: 0 }));
  await writeFile(join(cwd, 'corpus.json'), JSON.stringify([
    { id: 'b', text: 'return policy' }, { id: 'a', text: 'return return' }, { id: 'c', text: 'other' },
  ]));
  const treatment = join(root, 'treatment.md');
  await writeFile(treatment, '# Offline fixture knowledge\nUse the task input.\n');
  const executor = join(root, 'executor.mjs');
  await writeFile(executor, `#!${process.execPath}\n${program}`); await chmod(executor, 0o700);
  const samples = [
    { sampleId: 'classification', input: jsonInput({ task: 'classification', title: 'Invoice dispute' }), result: 'billing' },
    { sampleId: 'retrieval', input: jsonInput({ task: 'retrieval', query: 'return' }), result: ['a', 'b'] },
    { sampleId: 'history', input: { inputKind: 'messages', interactionMode: 'history', messages: [
      { messageId: 'u1', role: 'user', content: 'Check stock.' },
      { messageId: 'a1', role: 'assistant', content: 'Which color?' },
      { messageId: 'u2', role: 'user', content: 'red' },
    ] }, result: { sku: 'red', stock: 3 } },
    { sampleId: 'workflow', input: jsonInput({ task: 'workflow', amount: 20 }), result: { status: 'approved' } },
    { sampleId: 'workflow-rejected', input: jsonInput({ task: 'workflow', amount: -1 }), result: { status: 'rejected' } },
    { sampleId: 'workflow-manual', input: jsonInput({ task: 'workflow', amount: 101 }), result: { status: 'manual' } },
  ].map(({ result, ...sample }) => ({ ...sample, executionContext: { cwd },
    expected: { result: mode === 'wrong' ? 'deliberately incorrect' : result, sentinel: 'GOLD_SENTINEL', isolation: true },
    evaluationContext: { checks: [
      { checkKind: 'exact-match', checkId: 'result', actual: { sourceKind: 'output', pointer: mode === 'missing' ? '/absent' : '/result' }, expectedPointer: '/result', layer: 'fact' },
      { checkKind: 'exact-match', checkId: 'isolation', actual: { sourceKind: 'trace', pointer: '/isolationChecked' }, expectedPointer: '/isolation', layer: 'behavior' },
    ] },
  }));
  const path = join(root, 'samples.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 'omk.eval-sample-set/v3', samples }));
  const prepared = prepareCliEvaluation({ samples: path, executor, model: 'offline-fixture',
    control: 'baseline', treatment, 'no-judge': true, 'skip-doctor': true,
    'skip-connectivity': true, 'no-serve': true, 'output-dir': join(root, 'reports'),
  }, { projectRoot: root, lang: 'zh' });
  return runCoreEvaluationCommand({ prepared });
}

describe('v3 through the production CLI workflow and custom-command adapter', () => {
  it.each(['correct', 'wrong', 'missing'] as const)('measures four actual offline tasks: %s', async (mode) => {
    const result = await run(mode);
    expect(result.stored).toBeDefined();
    const records = result.stored!.evaluation.records;
    const observations = records.flatMap((record) => record.evaluationStatus === 'completed' ? record.observations : []);
    const observed = observations.filter((observation) => observation.observationStatus === 'observed');
    expect(new Set(records.map((record) => record.sampleId))).toEqual(new Set(['classification', 'retrieval', 'history', 'workflow', 'workflow-rejected', 'workflow-manual']));
    expect(observed.length).toBeGreaterThan(0);
    if (mode !== 'missing') {
      expect(records.every((record) => record.evaluationStatus === 'completed')).toBe(true);
      expect(observed).toHaveLength(records.length);
    }
    if (mode === 'correct') expect(observed.every((observation) => observation.value === true)).toBe(true);
    if (mode === 'wrong') expect(observed.some((observation) => observation.value === false)).toBe(true);
    if (mode === 'missing') expect(records.some((record) => record.evaluationStatus !== 'completed')
      || observations.some((observation) => observation.observationStatus === 'missing')).toBe(true);
  });
});
