import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { fixSamples } from '../../src/authoring/sample-fixer.js';
import type { EvaluationReport } from '../../src/types/report.js';
import type { Sample } from '../../src/types/index.js';

function reportWithSampleDesignFailure(): EvaluationReport {
  return {
    kind: 'evaluation',
    id: 'r1',
    meta: { variants: ['skill'] },
    summary: {},
    results: [{
      sample_id: 's1',
      variants: {
        skill: {
          diagnostic: {
            rootCause: ['sample_design'],
            summary: 'mock 缺失',
            expected: '应命中 Bash mock',
            actual: '被 mocksStrict 拦截',
            suggestion: { sample: '补一条 Bash mock' },
          },
          assertions: {
            details: [{ type: 'tool_input_contains', value: 'Bash:echo', passed: false }],
          },
        },
      },
    }],
  } as unknown as EvaluationReport;
}

describe('fixSamples', () => {
  it('merges only fixable fields, validates output, and keeps lean mode', async () => {
    const original: Sample = {
      sample_id: 's1',
      prompt: 'keep prompt',
      rubric: 'old rubric',
      capability: ['原能力'],
      provenance: 'human',
      mocks: [{ tool: 'Bash', match: { command_glob: 'pwd' }, return: { stdout: '/tmp', exit: 0 } }],
    };
    let seenLean: boolean | undefined;

    const result = await fixSamples({
      skillContent: 'Use Bash to run echo.',
      samples: [original],
      report: reportWithSampleDesignFailure(),
      treatmentKey: 'skill',
      executor: async (opts) => {
        seenLean = opts.lean;
        return {
          ok: true,
          costUSD: 0.01,
          text: JSON.stringify({
            sample_id: 'changed-by-llm',
            prompt: 'LLM tried to change prompt',
            capability: 'bad metadata',
            rubric: 'new rubric',
            assertions: [{ type: 'tool_input_contains', value: 'Bash:echo', weight: 1 }],
            mocks: [{ tool: 'Bash', match: { command_glob: 'echo *' }, return: { stdout: 'ok', exit: 0 } }],
          }),
        };
      },
    });

    assert.equal(seenLean, true);
    assert.equal(result.fixedCount, 1);
    assert.equal(result.samples[0].sample_id, 's1');
    assert.equal(result.samples[0].prompt, 'keep prompt');
    assert.deepEqual(result.samples[0].capability, ['原能力']);
    assert.equal(result.samples[0].provenance, 'human');
    assert.equal(result.samples[0].rubric, 'new rubric');
    assert.equal(result.samples[0].mocksStrict, true);
    assert.deepEqual(result.samples[0].assertions, [{ type: 'tool_input_contains', value: 'Bash:echo', weight: 1 }]);
  });

  it('does not write a fixed sample that fails sanitizer validation', async () => {
    const original: Sample = {
      sample_id: 's1',
      prompt: 'keep prompt',
      assertions: [{ type: 'contains', value: 'TOKEN', weight: 1 }],
    };

    const result = await fixSamples({
      skillContent: 'Use Bash.',
      samples: [original],
      report: reportWithSampleDesignFailure(),
      treatmentKey: 'skill',
      executor: async () => ({
        ok: true,
        costUSD: 0,
        text: JSON.stringify({
          assertions: [{ type: 'tools_called', values: [], weight: 1 }],
        }),
      }),
    });

    assert.equal(result.fixedCount, 0);
    assert.match(result.fixes[0].error ?? '', /sanitizer|tools_called/);
    assert.deepEqual(result.samples, [original]);
  });
});
