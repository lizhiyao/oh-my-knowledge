import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { fixSamples } from '../../src/authoring/sample-fixer.js';
import type { EvaluationReport } from '../../src/types/report.js';

function reportWithFailedAssertion(): EvaluationReport {
  return {
    kind: 'evaluation',
    id: 'r1',
    meta: {
      variants: ['skill'],
      model: 'sonnet',
      executor: 'claude',
      sampleCount: 1,
      taskCount: 1,
      totalCostUSD: 0,
      timestamp: '2026-05-16T00:00:00.000Z',
      cliVersion: '0.0.0-test',
      nodeVersion: process.version,
      artifactHashes: {},
      judgeModels: [],
    },
    summary: {},
    results: [
      {
        sample_id: 's001',
        variants: {
          skill: {
            ok: true,
            durationMs: 1,
            durationApiMs: 1,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            execCostUSD: 0,
            judgeCostUSD: 0,
            costUSD: 0,
            numTurns: 0,
            outputPreview: '',
            assertions: {
              passed: 0,
              total: 1,
              score: 1,
              details: [
                { type: 'contains', value: 'ok', passed: false, weight: 1 },
              ],
            },
          },
        },
      },
    ],
  };
}

describe('fixSamples', () => {
  it('skips samples that reached max attempts', async () => {
    let called = false;
    const result = await fixSamples({
      skillContent: 'Use Bash when needed.',
      samples: [{ sample_id: 's001', prompt: 'p', omkFix: { attempts: 2 } }],
      report: reportWithFailedAssertion(),
      treatmentKey: 'skill',
      model: 'test-model',
      maxAttemptsPerSample: 2,
      executor: async () => {
        called = true;
        return { ok: true, costUSD: 0, text: '[]' };
      },
    });

    assert.equal(called, false);
    assert.equal(result.fixedCount, 0);
    assert.equal(result.fixes[0].error, 'max attempts reached (2)');
  });

  it('stamps fix attempt metadata when a sample changes', async () => {
    const result = await fixSamples({
      skillContent: 'Use Bash when needed.',
      samples: [{ sample_id: 's001', prompt: 'p', assertions: [], provenance: 'llm-generated' }],
      report: reportWithFailedAssertion(),
      treatmentKey: 'skill',
      model: 'test-model',
      executor: async () => ({
        ok: true,
        costUSD: 0,
        text: JSON.stringify([{
          sample_id: 's001',
          prompt: 'p',
          assertions: [{ type: 'contains', value: 'ok' }],
          provenance: 'llm-generated',
        }]),
      }),
    });

    assert.equal(result.fixedCount, 1);
    assert.equal((result.samples[0].omkFix as { attempts: number }).attempts, 1);
  });

  it('rejects protected-field changes emitted by the fixer LLM', async () => {
    const result = await fixSamples({
      skillContent: 'Use Bash when needed.',
      samples: [{ sample_id: 's001', prompt: 'p', provenance: 'llm-generated' }],
      report: reportWithFailedAssertion(),
      treatmentKey: 'skill',
      model: 'test-model',
      executor: async () => ({
        ok: true,
        costUSD: 0,
        text: JSON.stringify([
          { sample_id: 's001', prompt: 'p2', provenance: 'llm-generated-fixed' },
        ]),
      }),
    });

    assert.equal(result.fixedCount, 0);
    assert.equal(result.samples[0].provenance, 'llm-generated');
    assert.match(result.fixes[0].error ?? '', /protected fields/);
  });

  it('rejects incomplete or extra fixer output atomically', async () => {
    const report = reportWithFailedAssertion();
    report.meta.sampleCount = 2;
    report.meta.taskCount = 2;
    report.results.push({
      ...report.results[0],
      sample_id: 's002',
    });
    const samples = [
      { sample_id: 's001', prompt: 'p1', assertions: [] },
      { sample_id: 's002', prompt: 'p2', assertions: [] },
    ];
    const result = await fixSamples({
      skillContent: 'Use Bash when needed.',
      samples,
      report,
      treatmentKey: 'skill',
      model: 'test-model',
      executor: async () => ({
        ok: true,
        costUSD: 0.1,
        text: JSON.stringify([{
          sample_id: 's001',
          prompt: 'p1',
          assertions: [{ type: 'contains', value: 'ok' }],
        }]),
      }),
    });

    assert.equal(result.fixedCount, 0);
    assert.deepEqual(result.samples, samples);
    assert.ok(result.fixes.every((fix) => /exactly once/.test(fix.error ?? '')));
  });

  it('preserves incurred cost and completeness when the returned sample is invalid', async () => {
    const result = await fixSamples({
      skillContent: 'Use Bash when needed.',
      samples: [{ sample_id: 's001', prompt: 'p', provenance: 'llm-generated' }],
      report: reportWithFailedAssertion(),
      treatmentKey: 'skill',
      model: 'test-model',
      executor: async () => ({
        ok: true,
        costUSD: 0.25,
        costReported: false,
        text: JSON.stringify([
          { sample_id: 's001', prompt: '', provenance: 'llm-generated' },
        ]),
      }),
    });

    assert.equal(result.fixedCount, 0);
    assert.equal(result.costUSD, 0.25);
    assert.equal(result.costReported, false);
    assert.match(result.fixes[0].error ?? '', /missing or invalid required prompt/);
  });

  it('removes impossible mocks when fixing samples for a mockless executor', async () => {
    let capturedSystem = '';
    const result = await fixSamples({
      skillContent: 'Do not call Write.',
      samples: [{
        sample_id: 's001',
        prompt: 'p',
        assertions: [],
        provenance: 'llm-generated',
      }],
      report: reportWithFailedAssertion(),
      treatmentKey: 'skill',
      model: 'test-model',
      mockless: true,
      executor: async (input) => {
        capturedSystem = input.system;
        return {
          ok: true,
          costUSD: 0,
          text: JSON.stringify([{
            sample_id: 's001',
            prompt: 'p',
            provenance: 'llm-generated',
            environment: { files_available: ['fixture.txt'] },
            mocks: [{ tool: 'Read', return: 'fixture' }],
            mocksStrict: true,
            assertions: [
              { type: 'mock_hit', value: 'Read:1' },
              { type: 'tools_not_called', values: ['Write'] },
            ],
          }]),
        };
      },
    });

    assert.match(capturedSystem, /目标执行器不支持工具调用拦截/);
    assert.equal(result.fixedCount, 1);
    assert.equal(result.samples[0].mocks, undefined);
    assert.equal(result.samples[0].mocksStrict, undefined);
    assert.deepEqual(result.samples[0].environment, {
      files_available: ['fixture.txt'],
    });
    assert.deepEqual(result.samples[0].assertions, [
      { type: 'tools_not_called', values: ['Write'] },
    ]);
  });
});
