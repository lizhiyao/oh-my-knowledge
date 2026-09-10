import { expect, it } from 'vitest';
import { createEvolutionEvaluator } from '../../../src/eval-workflows/hosts/composition/evolution-evaluation.js';
import type { CliEvaluationParseInput, CliEvaluationRequest } from '../../../src/eval-workflows/input-compilation/index.js';

it('keeps sample/runtime policy across rounds and rejects results without persisted evidence', async () => {
  const captured: CliEvaluationParseInput = {
    explicitCliFlags: { samples: '/fixed/samples.yaml', model: 'fixed-model', 'no-serve': false },
    defaults: {
      samplesLocator: 'unused.json', skillDirectoryLocator: '/skills',
      targetRuntime: { executorId: 'codex', model: 'default-model', effort: 'low' },
      judgeMembers: [{ executorId: 'codex', model: 'fixed-judge' }],
      presentation: { projectOutputDirectoryLocator: '/project/eval', globalOutputDirectoryLocator: '/global/eval', language: 'en', languageDefaultSource: 'environment-selection' },
    },
  };
  const requests: CliEvaluationRequest[] = [];
  const evaluate = createEvolutionEvaluator(captured, async (request) => {
    requests.push(request);
    return undefined;
  });
  await expect(evaluate('baseline', '/v1/review.md')).rejects.toThrow('persist');
  await expect(evaluate('/v1/review.md', '/v2/review.md')).rejects.toThrow('persist');
  for (const request of requests) {
    expect(request.values.locators.samples).toBe('/fixed/samples.yaml');
    expect(request.values.targetRuntime.model).toBe('fixed-model');
    expect(request.values.presentation.serve).toBe(false);
    expect(request.values.presentation.language).toBe('en');
  }
  expect(requests[0].values.variants).not.toEqual(requests[1].values.variants);
  expect(captured.explicitCliFlags['no-serve']).toBe(false);
});
