import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSamples } from '../../src/inputs/load-samples.js';
import { hashSample, hashString } from '../../src/eval-core/evaluation-reporting.js';
import { assertFixReportMatchesCurrentInputs, collectSampleDesignFailureIds, writeFixedSamplesToSources } from '../../src/cli/commands/sample.js';
import type { Report, Sample, VariantResult } from '../../src/types/index.js';

function makeVariantResult(rootCause: Array<'sample_design' | 'llm_misread'>): VariantResult {
  return {
    ok: false,
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
    numTurns: 1,
    outputPreview: null,
    diagnostic: {
      summary: 'bad sample',
      expected: 'expected',
      actual: 'actual',
      rootCause,
      suggestion: { skill: '', sample: 'fix sample', none: '' },
      ok: true,
    },
  };
}

function makeReport(treatmentName: string, skillContent: string, samples: Sample[]): Pick<Report, 'meta' | 'results'> {
  return {
    meta: {
      variants: [treatmentName],
      model: 'haiku',
      executor: 'claude',
      sampleCount: samples.length,
      taskCount: samples.length,
      totalCostUSD: 0,
      timestamp: '2026-05-14T00:00:00.000Z',
      cliVersion: 'test',
      nodeVersion: process.version,
      artifactHashes: { [treatmentName]: hashString(skillContent) },
      sampleHashes: Object.fromEntries(samples.map((sample) => [sample.sample_id, hashSample(sample)])),
      judgeModels: [{ executor: 'claude', model: 'haiku' }],
    },
    results: samples.map((sample) => ({
      sample_id: sample.sample_id,
      variants: { [treatmentName]: makeVariantResult(['sample_design']) },
    })),
  };
}

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

describe('sample --fix report fingerprint guard', () => {
  it('collects only sample_design failures for the requested treatment', () => {
    const report = makeReport('skill-a', 'skill content', [
      { sample_id: 's1', prompt: 'one' },
      { sample_id: 's2', prompt: 'two' },
    ]);
    report.results[1]!.variants['skill-a'] = makeVariantResult(['llm_misread']);

    assert.deepEqual([...collectSampleDesignFailureIds(report, 'skill-a')], ['s1']);
  });

  it('accepts a report whose skill and affected sample hashes match current inputs', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'one', rubric: 'rubric' }];
    const report = makeReport('skill-a', 'skill content', samples);

    assert.doesNotThrow(() => assertFixReportMatchesCurrentInputs({
      report,
      treatmentName: 'skill-a',
      skillContent: 'skill content',
      samples,
      sampleIds: new Set(['s1']),
      lang: 'zh',
    }));
  });

  it('rejects stale reports before writing fixes to current samples', () => {
    const reportSamples: Sample[] = [{ sample_id: 's1', prompt: 'old prompt', rubric: 'rubric' }];
    const currentSamples: Sample[] = [{ sample_id: 's1', prompt: 'new prompt', rubric: 'rubric' }];
    const report = makeReport('skill-a', 'old skill', reportSamples);

    assert.throws(
      () => assertFixReportMatchesCurrentInputs({
        report,
        treatmentName: 'skill-a',
        skillContent: 'new skill',
        samples: currentSamples,
        sampleIds: new Set(['s1']),
        lang: 'zh',
      }),
      /报告与当前输入不一致[\s\S]*skill 指纹不一致[\s\S]*用例指纹不一致：s1[\s\S]*重新运行 omk eval/,
    );
  });
});
