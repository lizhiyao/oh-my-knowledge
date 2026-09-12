import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson, type JsonValue } from '../../src/eval-core/contracts/index.js';
import type { ExecutionExecutor, ExecutorTrialContext } from '../../src/eval-core/execution/index.js';
import { loadSamples } from '../../src/eval-workflows/inputs/load-samples.js';
import {
  ConformanceRuntimeRegistry,
  prepareConformancePlan,
  revalidateConformanceResult,
  runConformanceScenario,
} from '../eval-core/conformance/harness.js';

// Design probes, not a public v3 loader. Every case uses the existing Core envelope.
const cases: { scenario: string; input: JsonValue; executionContext: JsonValue; expected: JsonValue; omitOutput?: boolean }[] = [
  {
    scenario: 'prompt',
    input: { inputKind: 'json', value: { title: 'Refund duplicate charge', body: 'I was charged twice.' } },
    executionContext: { categories: ['billing', 'technical'] },
    expected: { category: 'billing' },
  },
  {
    scenario: 'rag',
    input: { inputKind: 'json', value: { query: 'refund window' } },
    executionContext: { corpus: [
      { id: 'refund-policy', text: 'refund window 30 days' },
      { id: 'shipping-policy', text: 'shipping window 5 days' },
    ] },
    expected: { rankedIds: ['refund-policy', 'shipping-policy'], citation: 'refund-policy', text: 'refund window 30 days' },
  },
  {
    scenario: 'agent',
    input: { inputKind: 'messages', messages: [
      { role: 'user', content: 'Check stock.' },
      { role: 'assistant', content: 'Which SKU?' },
      { role: 'user', content: 'sku-red' },
    ] },
    executionContext: { inventory: { 'sku-red': 3, 'sku-blue': 0 } },
    expected: { tool: 'inventory.lookup', arguments: { sku: 'sku-red' }, result: 3 },
  },
  {
    scenario: 'workflow',
    input: { inputKind: 'json', value: { orderId: 'order-1', amount: 20 } },
    executionContext: { initialState: 'new', approvalLimit: 100 },
    expected: { state: 'approved', nodes: ['validate', 'approve'] },
  },
  {
    scenario: 'workflow-rejected',
    input: { inputKind: 'json', value: { orderId: 'invalid-order', amount: -1 } },
    executionContext: { initialState: 'new', approvalLimit: 100 },
    expected: { state: 'rejected', nodes: ['validate'] },
  },
  {
    scenario: 'workflow-review',
    input: { inputKind: 'json', value: { orderId: 'large-order', amount: 200 } },
    executionContext: { initialState: 'new', approvalLimit: 100 },
    expected: { state: 'pending-review', nodes: ['validate', 'approve'] },
  },
  {
    scenario: 'workflow-missing-evidence',
    input: { inputKind: 'json', value: { orderId: 'order-1', amount: 20 } },
    executionContext: { initialState: 'new', approvalLimit: 100 },
    expected: { state: 'approved', nodes: ['validate', 'approve'] },
    omitOutput: true,
  },
];

function record(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected object');
  return value as Record<string, JsonValue>;
}

async function executeOffline(scenario: string, trial: ExecutorTrialContext, root: string): Promise<JsonValue> {
  const input = record(trial.input);
  const environment = record(trial.executionContext);
  if (scenario === 'prompt') {
    const task = record(input.value);
    const words = `${task.title} ${task.body}`.toLowerCase();
    return { category: /refund|charge|invoice/.test(words) ? 'billing' : 'technical' };
  }
  if (scenario === 'rag') {
    const query = String(record(input.value).query).split(/\s+/);
    const corpus = environment.corpus as { id: string; text: string }[];
    const ranking = corpus.map((document) => ({
      ...document,
      score: query.filter((word) => document.text.split(/\s+/).includes(word)).length,
    })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { rankedIds: ranking.map((document) => document.id), citation: ranking[0].id, text: ranking[0].text };
  }
  if (scenario === 'agent') {
    const messages = input.messages as { role: string; content: string }[];
    const sku = messages.filter((message) => message.role === 'user').at(-1)?.content;
    if (sku === undefined) throw new TypeError('Missing SKU');
    const inventoryPath = join(root, 'inventory.json');
    await writeFile(inventoryPath, JSON.stringify(environment.inventory));
    const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as Record<string, number>;
    return { tool: 'inventory.lookup', arguments: { sku }, result: inventory[sku] ?? 0 };
  }
  const order = record(input.value);
  const statePath = join(root, 'state.json');
  await writeFile(statePath, JSON.stringify({ state: environment.initialState, nodes: [] }));
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { state: string; nodes: string[] };
  state.nodes.push('validate');
  if (Number(order.amount) <= 0) state.state = 'rejected';
  else {
    state.nodes.push('approve');
    state.state = Number(order.amount) <= Number(environment.approvalLimit) ? 'approved' : 'pending-review';
  }
  await writeFile(statePath, JSON.stringify(state));
  return JSON.parse(await readFile(statePath, 'utf8')) as JsonValue;
}

describe('general sample design offline feasibility', () => {
  it.each(cases)('$scenario: executes, grades positive/negative evidence, and materializes a verified report', async (probe) => {
    const root = await mkdtemp(join(tmpdir(), 'omk-sample-proposal-'));
    const trialRoots: string[] = [];
    let trialDisposals = 0;
    try {
      const plan = await prepareConformancePlan('function', (definition) => {
        definition.dataset.samples = [{
          sampleId: probe.scenario,
          input: probe.input,
          executionContext: probe.executionContext,
          expected: { answer: canonicalizeJson(probe.expected), secret: 'GOLD_SENTINEL_842' },
          evaluationContext: { notes: 'EVALUATOR_ONLY_842' },
        }];
      });
      const registry = new ConformanceRuntimeRegistry('function', plan);
      const original = registry.executorsByTargetId.get('control')!;
      const executor: ExecutionExecutor = {
        identity: original.identity,
        async openRun() {
          return {
            async openTrial(trial) {
              expect(JSON.stringify(trial)).not.toMatch(/GOLD_SENTINEL_842|EVALUATOR_ONLY_842/);
              expect(trial).not.toHaveProperty('expected');
              expect(trial).not.toHaveProperty('evaluationContext');
              expect(trial.input).toEqual(probe.input);
              const trialRoot = await mkdtemp(join(root, 'trial-'));
              trialRoots.push(trialRoot);
              return {
                async execute() {
                  const actual = await executeOffline(probe.scenario, trial, trialRoot);
                  if (probe.omitOutput) return {};
                  // Corruption control tests grading sensitivity, not model improvement.
                  const answer = trial.targetId === 'control' ? canonicalizeJson(actual) : 'CORRUPTED_OUTCOME';
                  return { output: { value: { answer, actual }, classification: 'public' } };
                },
                async dispose() {
                  await rm(trialRoot, { recursive: true, force: true });
                  trialDisposals += 1;
                },
              };
            },
            async dispose() {},
          };
        },
      };
      const result = await runConformanceScenario('function', {
        plan,
        suffix: probe.scenario,
        executorsByTargetId: new Map(plan.execution.targets.map((target) => [target.targetId, executor])),
      });
      expect(result.execution.executionBundleStatus).toBe('completed');
      expect(result.evaluation.evaluationBundleStatus).toBe('completed');
      const values = result.evaluation.records.map((entry) => (
        'observations' in entry && 'value' in entry.observations[0] ? entry.observations[0].value : null
      )).sort();
      expect(values).toEqual(probe.omitOutput ? [null, null] : [false, true]);
      expect(result.report.status.runStatus).toBe('completed');
      if (probe.omitOutput) {
        expect(result.report.status.evidenceStatus).not.toBe('complete');
        expect(result.report.status.conclusionStatus).not.toBe('conclusive');
      } else revalidateConformanceResult(result);
      expect(trialDisposals).toBe(2);
      expect(new Set(trialRoots).size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a proposed structured envelope through the actual v2 loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omk-proposal-v2-'));
    try {
      const path = join(root, 'samples.json');
      await writeFile(path, JSON.stringify({
        schemaVersion: 'omk.eval-sample-set/v2',
        samples: [{ sample_id: 'structured', input: cases[0].input }],
      }));
      expect(() => loadSamples(path)).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
