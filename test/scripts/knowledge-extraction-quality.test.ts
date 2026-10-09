import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureQualityCases, parseQualityArguments, parseQualityCases, qualityInput, qualityOutputRoot,
} from '../../scripts/bench/knowledge-extraction-quality.js';
import { checkExtractionResponse, extractionResponseChecker } from '../../src/observability/knowledge-extraction/proposals.js';

import { modelProposal, proposal } from '../knowledge/fixtures.js';

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
    const outputs = ['not-json', '{"proposals":[{}]}', '{"proposals":[]}'];
    const result = await captureQualityCases({ cases: cases.slice(0, 3), output, prompt: 'fixed',
      signal: new AbortController().signal, check: checkExtractionResponse,
      generate: async () => ({ output: outputs[count++]! }),
    });
    expect(result).toEqual({ failed: true, aborted: false, attempted: 3 });
    const records = cases.slice(0, 3).map(({ caseId }) => JSON.parse(readFileSync(join(output, `${caseId}.json`), 'utf8')));
    expect(records[0].runtime.output).toBe('not-json');
    expect(records[0].failure).toBeTruthy();
    expect(records[1].checked.rejected).toHaveLength(1);
    expect(records[2].checked).toEqual({ accepted: [], rejected: [] });
    expect(records.every((record) => record.semanticReview === 'pending')).toBe(true);
  });

  it('captures each prompt version with its own admission policy and the same input bytes', async () => {
    const sample = { caseId: 'quote-position', provenance: 'synthetic', messages: [{ role: 'user' as const, text: 'Alpha 使用 Beta。' }], reviewChecks: ['引用必须逐字匹配'] };
    const records = [];
    for (const version of ['knowledge-extraction-v1', 'knowledge-extraction-v2']) {
      const output = tempRoot();
      const candidate = version === 'knowledge-extraction-v1' ? proposal() : modelProposal();
      if (version === 'knowledge-extraction-v1') Object.assign(candidate.citations[0].selection, { end: 14 });
      const raw = JSON.stringify({ proposals: [candidate] }).replaceAll('record-1', 'quote-position:0');
      await captureQualityCases({ cases: [sample], output, prompt: version, signal: new AbortController().signal,
        check: extractionResponseChecker(version), generate: async () => ({ output: raw }),
      });
      const record = JSON.parse(readFileSync(join(output, 'quote-position.json'), 'utf8'));
      expect(record.runtime.output).toBe(raw);
      records.push(record);
    }
    expect(records[0].inputDigest).toBe(records[1].inputDigest);
    expect(records[0].checked.rejected[0].reasons).toContain('citation:quote_mismatch');
    expect(records[1].checked.rejected).toEqual([]);
    expect(records[1].checked.accepted[0].citations[0].selection).toMatchObject({ start: 0, end: 13 });
    expect(records[1].semanticReview).toBe('pending');
  });

  it('stops subsequent calls when an output cannot be persisted', async () => {
    let calls = 0;
    await expect(captureQualityCases({ cases, output: join(tempRoot(), 'missing'), prompt: 'fixed',
      signal: new AbortController().signal, check: checkExtractionResponse,
      generate: async () => { calls += 1; return { output: '{"proposals":[]}' }; },
    })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('records cancellation and makes no further model calls', async () => {
    const output = tempRoot();
    const controller = new AbortController();
    let calls = 0;
    const result = await captureQualityCases({ cases, output, prompt: 'fixed', signal: controller.signal,
      check: checkExtractionResponse, generate: async () => {
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
