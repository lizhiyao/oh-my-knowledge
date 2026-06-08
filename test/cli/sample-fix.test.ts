import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSamples } from '../../src/inputs/load-samples.js';
import { hashSample } from '../../src/eval-core/evaluation-reporting.js';
import { hashArtifactSource } from '../../src/inputs/content-hash.js';
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

// contentHash 直接传入(整树哈,由调用方算好);schemaVersion 默认 2(树哈纪元),传 undefined 模拟旧报告。
function makeReport(
  treatmentName: string,
  contentHash: string,
  samples: Sample[],
  schemaVersion: number | null = 2, // null = 模拟无 schemaVersion 字段的旧报告(显式 undefined 会触发默认值 2)
): Pick<Report, 'meta' | 'results'> {
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
      ...(schemaVersion !== null ? { schemaVersion } : {}),
      artifactHashes: { [treatmentName]: contentHash },
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
    const report = makeReport('skill-a', 'hash-a', [
      { sample_id: 's1', prompt: 'one' },
      { sample_id: 's2', prompt: 'two' },
    ]);
    report.results[1]!.variants['skill-a'] = makeVariantResult(['llm_misread']);

    assert.deepEqual([...collectSampleDesignFailureIds(report, 'skill-a')], ['s1']);
  });

  it('accepts a report whose skill tree hash and affected sample hashes match current inputs', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'one', rubric: 'rubric' }];
    const report = makeReport('skill-a', 'tree-hash-a', samples);

    assert.doesNotThrow(() => assertFixReportMatchesCurrentInputs({
      report,
      treatmentName: 'skill-a',
      currentContentHash: 'tree-hash-a',
      samples,
      sampleIds: new Set(['s1']),
      lang: 'zh',
    }));
  });

  it('rejects stale reports before writing fixes to current samples', () => {
    const reportSamples: Sample[] = [{ sample_id: 's1', prompt: 'old prompt', rubric: 'rubric' }];
    const currentSamples: Sample[] = [{ sample_id: 's1', prompt: 'new prompt', rubric: 'rubric' }];
    const report = makeReport('skill-a', 'old-tree-hash', reportSamples);

    assert.throws(
      () => assertFixReportMatchesCurrentInputs({
        report,
        treatmentName: 'skill-a',
        currentContentHash: 'new-tree-hash',
        samples: currentSamples,
        sampleIds: new Set(['s1']),
        lang: 'zh',
      }),
      /报告与当前输入不一致[\s\S]*skill 指纹不一致[\s\S]*用例指纹不一致：s1[\s\S]*重新运行 omk eval/,
    );
  });

  it('改 references/ 资产后,当前树哈漂移被报为 skill 指纹不一致(资产敏感)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-asset-drift-'));
    const root = join(dir, 'review');
    mkdirSync(join(root, 'references'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# review\n');
    writeFileSync(join(root, 'references', 'cmd.md'), 'asset v1\n');
    const reportHash = hashArtifactSource(root, true); // 报告记的是资产 v1 时的整树哈
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'one', rubric: 'rubric' }];
    const report = makeReport('review', reportHash, samples);

    writeFileSync(join(root, 'references', 'cmd.md'), 'asset v2\n'); // 只改资产,SKILL.md 正文不变
    const currentHash = hashArtifactSource(root, true);
    assert.notEqual(reportHash, currentHash, '资产改动必须改变整树哈');

    assert.throws(
      () => assertFixReportMatchesCurrentInputs({
        report,
        treatmentName: 'review',
        currentContentHash: currentHash,
        samples,
        sampleIds: new Set(['s1']),
        lang: 'zh',
      }),
      /skill 指纹不一致/,
    );
  });

  it('schemaVersion < 2 的旧报告命中树哈纪元 guard,不拿旧文本哈错配比对', () => {
    const samples: Sample[] = [{ sample_id: 's1', prompt: 'one', rubric: 'rubric' }];
    // 旧报告(无 schemaVersion):即便 contentHash 字面与 current 相等也应走 guard,不做等值比对。
    const report = makeReport('skill-a', 'same-hash', samples, null);

    assert.throws(
      () => assertFixReportMatchesCurrentInputs({
        report,
        treatmentName: 'skill-a',
        currentContentHash: 'same-hash',
        samples,
        sampleIds: new Set(['s1']),
        lang: 'zh',
      }),
      /早于树哈纪元[\s\S]*重新运行 omk eval/,
    );
  });
});
