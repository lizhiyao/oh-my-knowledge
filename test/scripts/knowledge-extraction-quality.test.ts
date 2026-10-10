import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertHistoricalQualityRuntime, captureQualityCases, parseQualityArguments, parseQualityCases, qualityInput, qualityOutputRoot,
} from '../../scripts/bench/knowledge-extraction-quality.js';
import { checkWindowExtractionResponse } from '../../src/observability/knowledge-extraction/window-proposals.js';
import { checkCriticalEntities, entityQualityCases, entityQualityInput, expectedEntityMentions, parseEntityQualityArguments, parseEntityQualityCorpus } from '../../scripts/bench/entity-extraction-quality.js';

import { modelWindow } from '../knowledge/fixtures.js';

const roots: string[] = [];
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-quality-test-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const cases = parseQualityCases(readFileSync(new URL('../fixtures/knowledge-extraction-quality.json', import.meta.url), 'utf8'));

describe('knowledge extraction quality evidence', () => {
  it('refuses to combine historical gold and prompts with a replacement runtime before model setup', () => {
    expect(() => assertHistoricalQualityRuntime('knowledge-extraction-v3')).not.toThrow();
    for (const version of ['knowledge-extraction-v4', 'knowledge-extraction-v5', undefined]) {
      expect(() => assertHistoricalQualityRuntime(version)).toThrow('frozen base revision');
    }
  });
  it('freezes entity identities and UTF-16 repeated occurrences without sending the gold answers to the model', () => {
    const corpus = parseEntityQualityCorpus(readFileSync(new URL('../fixtures/entity-extraction-quality.json', import.meta.url), 'utf8'));
    expect(corpus.cases).toHaveLength(16);
    const repeated = corpus.cases.find(sample => sample.caseId === 'repeated-quote')!;
    expect(expectedEntityMentions(repeated).slice(0, 2).map(mention => mention.start)).toEqual([3, 11]);
    const sample = entityQualityCases(corpus).find(sample => sample.caseId === 'missing-context')!;
    const input = entityQualityInput(corpus, sample);
    expect(input.limitations).toContain(corpus.cases.find(entry => entry.caseId === sample.caseId)!.limitations![0]);
    expect(JSON.stringify(input)).not.toContain('possibleEntities'); expect(JSON.stringify(input)).not.toContain('reviewChecks');
    const invalid = structuredClone(corpus); invalid.cases[0].mentions[0].occurrence = 99;
    expect(() => parseEntityQualityCorpus(JSON.stringify(invalid))).toThrow();
    invalid.cases[0].mentions[0].occurrence = 0; invalid.cases[0].roles[0].subject = 'invented';
    expect(() => parseEntityQualityCorpus(JSON.stringify(invalid))).toThrow();
  });
  it('separates omitted knowledge, missed mentions, identity merging and unresolved alternatives', () => {
    const corpus = parseEntityQualityCorpus(readFileSync(new URL('../fixtures/entity-extraction-quality.json', import.meta.url), 'utf8'));
    const sample = corpus.cases.find(sample => sample.caseId === 'unresolved-choice')!;
    const empty = checkWindowExtractionResponse({ responseKind: 'knowledge-extraction', schemaVersion: 4, entities: [], mentions: [], proposals: [] }, qualityInput(entityQualityCases(corpus).find(value => value.caseId === sample.caseId)!).excerpts);
    const result = checkCriticalEntities(sample, empty);
    expect(result.criticalMentions.every(value => !value.covered)).toBe(true);
    expect(result.separations.every(value => !value.passed)).toBe(true);
    expect(result.unresolved[0].passed).toBe(false);
    expect(result.semanticReview).toBe('pending'); expect(result.independentReview).toBe('not_performed');
    const input = ['--output', '/outside/new', '--model', 'fixed', '--repeat', '2'];
    expect(parseEntityQualityArguments(input).repeat).toBe(2);
    expect(() => parseEntityQualityArguments([...input, '--repeat', '1'])).toThrow();
    expect(() => parseEntityQualityArguments(['--output', '/outside/new', '--model', 'fixed', '--repeat', '3'])).toThrow();
  });
  it('detects a structurally valid merged identity and role swap against frozen spans', () => {
    const sample = { caseId: 'role-check', messages: [{ role: 'user' as const, text: 'Alpha 使用 Beta' }],
      mentions: [{ mentionKey: 'alpha', entity: 'alpha', messageIndex: 0, quote: 'Alpha', occurrence: 0 },
        { mentionKey: 'beta', entity: 'beta', messageIndex: 0, quote: 'Beta', occurrence: 0 }],
      separate: [['alpha', 'beta'] as [string, string]], roles: [{ subject: 'alpha', object: 'beta', relationKeywords: ['使用'] }], checks: ['Keep roles and identities.'] };
    const excerpts = qualityInput({ ...sample, provenance: 'synthetic', reviewChecks: sample.checks }).excerpts;
    const packet = JSON.parse(JSON.stringify(modelWindow()).replaceAll('record-1', 'role-check:0'));
    const checked = checkWindowExtractionResponse(packet, excerpts);
    expect(checkCriticalEntities(sample, checked).separations[0].passed).toBe(true);
    expect(checkCriticalEntities(sample, checked).roles[0].status).toBe('matched');
    packet.proposals[0].draft.content.statements[0].subject.entityId = 'tool'; packet.proposals[0].draft.content.statements[0].object.entityId = 'project';
    expect(checkCriticalEntities(sample, checkWindowExtractionResponse(packet, excerpts)).roles[0].status).toBe('mismatched');
    packet.proposals = []; packet.entities = packet.entities.slice(0, 1); packet.mentions[1].entityId = 'project';
    const merged = checkWindowExtractionResponse(packet, excerpts); expect(merged.analysis.rejected).toEqual([]);
    const result = checkCriticalEntities(sample, merged);
    expect(result.criticalMentions.every(mention => mention.exact)).toBe(true);
    expect(result.separations[0].passed).toBe(false); expect(result.roles[0].status).toBe('not_observed');
    expect(result.semanticReview).toBe('pending');
  });
  it('requires explicit model and output, rejecting malformed or repeated flags before calling a model', () => {
    expect(parseQualityArguments(['--model', 'fixed-model', '--output', '/outside/new'])).toEqual({
      model: 'fixed-model', output: '/outside/new', prompt: undefined,
    });
    for (const args of [[], ['--model', 'm'], ['--model', '--output', '/out'],
      ['--model', 'm', '--output', '/out', '--model', 'n'], ['--unknown', 'x']]) {
      expect(() => parseQualityArguments(args)).toThrow();
    }
  });

  it('rejects malformed cases, duplicate identities and unsafe output file names', () => {
    expect(cases).toHaveLength(6);
    for (const value of [[], [cases[0], cases[0]], [{ ...cases[0], caseId: '../outside' }],
      [{ ...cases[0], messages: [{ role: 'tool', text: 'result' }] }], [{ ...cases[0], reviewChecks: [] }]]) {
      expect(() => parseQualityCases(JSON.stringify(value))).toThrow();
    }
  });

  it('keeps fixed message identities and omissions while excluding review criteria from model input', () => {
    const sample = cases.find(({ caseId }) => caseId === 'corrected-release')!;
    const input = qualityInput(sample);
    expect(qualityInput({ ...sample, reviewChecks: ['different review'] })).toEqual(input);
    expect(input.excerpts.map(({ evidenceRef, role }) => [evidenceRef, role])).toEqual([
      ['corrected-release:0', 'user'], ['corrected-release:1', 'assistant'], ['corrected-release:2', 'user'],
    ]);
    expect(input.excerpts.at(-1)?.text).toBe(sample.messages.at(-1)?.text);
    expect(input.limitations[0]).toContain('Tool calls, tool results');
    expect(JSON.stringify(input)).not.toContain('reviewChecks');
  });

  it('rejects repository output even through a symlink and permits a new external directory', () => {
    const root = tempRoot();
    const repo = join(root, 'repo');
    mkdirSync(repo);
    symlinkSync(repo, join(root, 'link'), 'dir');
    for (const requested of ['relative', repo, join(repo, 'run'), join(root, 'link', 'run')]) {
      expect(() => qualityOutputRoot(repo, requested)).toThrow();
    }
    expect(qualityOutputRoot(repo, join(root, 'run'))).toBe(join(realpathSync(root), 'run'));
  });

  it('preserves original output and structural failures without turning accepted proposals into a semantic verdict', async () => {
    const output = tempRoot();
    let count = 0;
    const empty = { responseKind: 'knowledge-extraction', schemaVersion: 4, entities: [], mentions: [], proposals: [] };
    const outputs = ['not-json', JSON.stringify({ ...empty, proposals: [{}] }), JSON.stringify(empty)];
    const result = await captureQualityCases({ cases: cases.slice(0, 3), output, prompt: 'fixed',
      signal: new AbortController().signal, check: checkWindowExtractionResponse,
      generate: async () => ({ output: outputs[count++]! }),
    });
    expect(result).toEqual({ failed: true, aborted: false, attempted: 3 });
    const records = cases.slice(0, 3).map(({ caseId }) => JSON.parse(readFileSync(join(output, `${caseId}.json`), 'utf8')));
    expect(records[0].runtime.output).toBe('not-json');
    expect(records[0].failure).toBeTruthy();
    expect(records[1].checked.rejected).toHaveLength(1);
    expect(records[2].checked).toMatchObject({ accepted: [], rejected: [], analysis: { entities: [], mentions: [], rejected: [] } });
    expect(records.every((record) => record.semanticReview === 'pending')).toBe(true);
  });

  it('stops subsequent calls when an output cannot be persisted', async () => {
    let calls = 0;
    await expect(captureQualityCases({ cases, output: join(tempRoot(), 'missing'), prompt: 'fixed',
      signal: new AbortController().signal, check: checkWindowExtractionResponse,
      generate: async () => { calls += 1; return { output: JSON.stringify({ ...modelWindow(), entities: [], mentions: [], proposals: [] }) }; },
    })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('records independent entities and treats entity rejections as structural failure even with zero knowledge', async () => {
    const sample = { caseId: 'entity-only', provenance: 'synthetic', messages: [{ role: 'user' as const, text: 'Alpha 使用 Beta' }], reviewChecks: ['按对象核对'] };
    const packet = modelWindow(); packet.proposals = []; packet.mentions[1].selection.quote = 'invented';
    const output = tempRoot();
    const result = await captureQualityCases({ cases: [sample], output, prompt: 'fixed-current', signal: new AbortController().signal,
      check: checkWindowExtractionResponse,
      generate: async () => ({ output: JSON.stringify(packet).replaceAll('record-1', 'entity-only:0') }) });
    expect(result).toMatchObject({ failed: true, attempted: 1 });
    const record = JSON.parse(readFileSync(join(output, 'entity-only.json'), 'utf8'));
    expect(record.checked.accepted).toEqual([]); expect(record.checked.analysis.entities).toHaveLength(1);
    expect(record.checked.analysis.rejected).toHaveLength(2); expect(record.semanticReview).toBe('pending');
  });

  it('records cancellation and makes no further model calls', async () => {
    const output = tempRoot();
    const controller = new AbortController();
    let calls = 0;
    const result = await captureQualityCases({ cases, output, prompt: 'fixed', signal: controller.signal,
      check: checkWindowExtractionResponse, generate: async () => {
        calls += 1;
        controller.abort();
        throw new Error('cancelled');
      },
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ failed: true, aborted: true, attempted: 1 });
    expect(JSON.parse(readFileSync(join(output, `${cases[0]!.caseId}.json`), 'utf8')).failure).toBe('cancelled');
  });
});
