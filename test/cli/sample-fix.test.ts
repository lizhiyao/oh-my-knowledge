import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSamples } from '../../src/inputs/load-samples.js';
import { writeFixedSamplesToSources } from '../../src/cli/commands/sample.js';
import type { Sample } from '../../src/types/index.js';

describe('sample --fix source writes', () => {
  it('writes changed samples back to their original file and preserves wrappers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-sample-fix-'));
    const omkDir = join(dir, '.omk');
    mkdirSync(omkDir);
    const workflowPath = join(omkDir, 'workflow.json');
    const platformPath = join(omkDir, 'platform.json');
    writeFileSync(workflowPath, JSON.stringify({
      requires: { tools: ['git'] },
      samples: [{ sample_id: 's1', prompt: 'old one' }],
    }, null, 2));
    writeFileSync(platformPath, JSON.stringify([
      { sample_id: 's2', prompt: 'old two' },
    ], null, 2));

    const loaded = loadSamples(omkDir);
    assert.equal(loaded.sampleSourceById.s1, workflowPath);
    assert.equal(loaded.sampleSourceById.s2, platformPath);

    const fixedSamples: Sample[] = loaded.samples.map((sample) => (
      sample.sample_id === 's1' ? { ...sample, rubric: 'new rubric' } : sample
    ));
    const written = writeFixedSamplesToSources(loaded, fixedSamples, new Set(['s1']));

    assert.deepEqual(written, [workflowPath]);
    const workflow = JSON.parse(readFileSync(workflowPath, 'utf-8')) as { requires: unknown; samples: Sample[] };
    assert.deepEqual(workflow.requires, { tools: ['git'] });
    assert.equal(workflow.samples[0].rubric, 'new rubric');
    const platform = JSON.parse(readFileSync(platformPath, 'utf-8')) as Sample[];
    assert.equal(platform[0].prompt, 'old two');
  });
});
