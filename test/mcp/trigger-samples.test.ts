import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';
import { loadSamples } from '../../src/inputs/load-samples.js';

const samplePath = resolve('examples/mcp-observation/eval-samples.json');

describe('MCP observation trigger validation samples', () => {
  it('keeps direct, indirect, and negative consent boundaries executable', () => {
    const { samples } = loadSamples(samplePath);
    assert.equal(samples.length, 5);

    const byId = new Map(samples.map((sample) => [sample.sample_id, sample]));
    const direct = byId.get('direct-explicit-capture');
    const indirect = byId.get('indirect-correction-await-confirmation');
    const confirmed = byId.get('indirect-correction-confirmed');
    const negative = byId.get('negative-hypothetical-example');
    const unreviewed = byId.get('negative-unreviewed-draft');
    assert.ok(direct && indirect && confirmed && negative && unreviewed);

    assert.deepEqual(toolAssertion(direct, 'tools_called'), ['save_observation']);
    assert.deepEqual(toolAssertion(confirmed, 'tools_called'), ['save_observation']);
    assert.deepEqual(toolAssertion(indirect, 'tools_not_called'), [
      'save_observation',
      'draft_sample_from_observation',
    ]);
    assert.deepEqual(toolAssertion(negative, 'tools_not_called'), [
      'save_observation',
      'record_observation_review',
      'draft_sample_from_observation',
    ]);
    assert.deepEqual(toolAssertion(unreviewed, 'tools_not_called'), [
      'save_observation',
      'record_observation_review',
      'draft_sample_from_observation',
    ]);
  });

  it('requires explicit confirmation and never permits capture to skip review', () => {
    const { samples } = loadSamples(samplePath);
    const captureSamples = samples.filter((sample) =>
      toolAssertion(sample, 'tools_called')?.includes('save_observation'));
    assert.equal(captureSamples.length, 2);

    for (const sample of captureSamples) {
      assert.equal(
        sample.assertions?.some((assertion) =>
          assertion.type === 'tool_input_contains' &&
          assertion.value === 'save_observation:"confirmedByUser":true'),
        true,
      );
      assert.equal(
        toolAssertion(sample, 'tools_not_called')?.includes('draft_sample_from_observation'),
        true,
      );
    }
  });
});

function toolAssertion(
  sample: ReturnType<typeof loadSamples>['samples'][number],
  type: 'tools_called' | 'tools_not_called',
): string[] | undefined {
  return sample.assertions?.find((assertion) => assertion.type === type)?.values;
}
