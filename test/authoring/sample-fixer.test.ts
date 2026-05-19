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
      samples: [{ sample_id: 's001', prompt: 'p', provenance: 'llm-generated' }],
      report: reportWithFailedAssertion(),
      treatmentKey: 'skill',
      executor: async () => ({
        ok: true,
        costUSD: 0,
        text: JSON.stringify([{ sample_id: 's001', prompt: 'p2', provenance: 'llm-generated' }]),
      }),
    });

    assert.equal(result.fixedCount, 1);
    assert.equal((result.samples[0].omkFix as { attempts: number }).attempts, 1);
  });

  it('normalizes invalid provenance emitted by the fixer LLM', async () => {
    const result = await fixSamples({
      skillContent: 'Use Bash when needed.',
      samples: [{ sample_id: 's001', prompt: 'p', provenance: 'llm-generated' }],
      report: reportWithFailedAssertion(),
      treatmentKey: 'skill',
      executor: async () => ({
        ok: true,
        costUSD: 0,
        text: JSON.stringify([
          { sample_id: 's001', prompt: 'p2', provenance: 'llm-generated-fixed' },
        ]),
      }),
    });

    assert.equal(result.fixedCount, 1);
    assert.equal(result.samples[0].provenance, 'llm-generated');
  });
});
